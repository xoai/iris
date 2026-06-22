// RedisStateStore — the StateStore port over Redis. The crux is `append`: an optimistic
// transaction that WATCHes the per-session meta key (the linearization point), reads
// hwm/fence, checks the fence BEFORE the seq (stale_fence precedence), then commits the
// journal rows + the new hwm/fence in ONE MULTI/EXEC. A concurrent writer's commit fails
// our EXEC with a WatchError, so exactly one writer wins — the Redis analog of the SQL
// stores' `SELECT … FOR UPDATE`. Byte payloads are base64-encoded (avoids node-redis
// binary-mode friction); they round-trip exactly. Certified by @irisrun/store-conformance.
import type { StateStore, Version, CasResult, AppendResult, JournalRow } from "@irisrun/core";
import { type RedisLike, isWatchError } from "./redis.ts";

const toB64 = (u8: Uint8Array): string => Buffer.from(u8).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
// Values are stored as strings; numbers (seq/version/fence) are within JS Number range
// (documented assumption, as in the SQL stores).
const num = (v: unknown): number => Number(v);

const kvKey = (key: string): string => `iris:kv:${key}`;
const metaKey = (session: string): string => `iris:meta:${session}`;
const journalKey = (session: string): string => `iris:journal:${session}`;
const snapKey = (session: string): string => `iris:snap:${session}`;

export class RedisStateStore implements StateStore {
  // Explicit field (NOT a constructor parameter property) — Node's strip-only TS mode,
  // which runs the test suite, rejects parameter properties.
  private readonly redis: RedisLike;
  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const h = await this.redis.hGetAll(kvKey(key));
    if (!h || h.version === undefined) return null;
    return { bytes: fromB64(h.bytes), version: num(h.version) };
  }

  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    const k = kvKey(key);
    return this.redis.executeIsolated(async (iso) => {
      await iso.watch(k);
      const cur = await iso.hGetAll(k);
      const exists = cur && cur.version !== undefined;
      const curVersion = exists ? num(cur.version) : 0;
      // Guard: null ⇒ must-not-exist; versioned ⇒ stored version must equal expected.
      if (expected === null ? exists : !exists || curVersion !== expected) {
        return { ok: false, current: curVersion } as CasResult;
      }
      const nextVersion = expected === null ? 1 : expected + 1;
      try {
        await iso
          .multi()
          .hSet(k, "version", String(nextVersion))
          .hSet(k, "bytes", toB64(next))
          .exec();
        return { ok: true, version: nextVersion } as CasResult;
      } catch (e) {
        if (!isWatchError(e)) throw e;
        // A concurrent writer committed first — re-read the authoritative current.
        const re = await this.redis.hGetAll(k);
        return { ok: false, current: re && re.version !== undefined ? num(re.version) : 0 } as CasResult;
      }
    });
  }

  async append(sessionId: string, expectedSeq: number, records: Uint8Array[], fence: Version): Promise<AppendResult> {
    const mk = metaKey(sessionId);
    const jk = journalKey(sessionId);
    return this.redis.executeIsolated(async (iso) => {
      await iso.watch(mk);
      const meta = await iso.hGetAll(mk);
      const hwm = meta && meta.hwm !== undefined ? num(meta.hwm) : -1;
      const storedFence = meta && meta.fence !== undefined ? num(meta.fence) : 0;
      // Fence check FIRST (stale_fence precedence) — return WITHOUT exec on a checked
      // rejection (the WATCH simply lapses when executeIsolated returns).
      if (fence < storedFence) {
        return { ok: false, reason: "stale_fence", currentFence: storedFence } as AppendResult;
      }
      if (hwm !== expectedSeq - 1) {
        return { ok: false, reason: "seq_conflict", currentSeq: hwm } as AppendResult;
      }
      // Empty batch ⇒ no-op success returning the current hwm (no exec).
      if (records.length === 0) {
        return { ok: true, seq: hwm } as AppendResult;
      }
      let seq = hwm;
      const multi = iso.multi();
      for (const bytes of records) {
        seq += 1;
        multi.hSet(jk, String(seq), toB64(bytes));
      }
      const newFence = Math.max(storedFence, fence);
      multi.hSet(mk, "hwm", String(seq));
      multi.hSet(mk, "fence", String(newFence));
      try {
        await multi.exec();
        return { ok: true, seq } as AppendResult;
      } catch (e) {
        if (!isWatchError(e)) throw e;
        // A concurrent append committed first — re-read the authoritative hwm.
        const re = await this.redis.hGetAll(mk);
        const newHwm = re && re.hwm !== undefined ? num(re.hwm) : -1;
        return { ok: false, reason: "seq_conflict", currentSeq: newHwm } as AppendResult;
      }
    });
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const h = await this.redis.hGetAll(journalKey(sessionId));
    const rows: JournalRow[] = [];
    for (const field of Object.keys(h ?? {})) {
      const seq = num(field);
      if (seq >= fromSeq) rows.push({ seq, bytes: fromB64(h[field]) });
    }
    rows.sort((a, b) => a.seq - b.seq); // NUMERIC sort (hash fields have no order)
    return rows;
  }

  async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
    const mk = metaKey(sessionId);
    const sk = snapKey(sessionId);
    // Snapshot write + hwm seed must be atomic so a concurrent append sees the raised hwm.
    // Bounded retry: a WatchError here means meta moved under us — just redo the read/commit.
    for (;;) {
      const done = await this.redis.executeIsolated(async (iso) => {
        await iso.watch(mk);
        const meta = await iso.hGetAll(mk);
        const hwm = meta && meta.hwm !== undefined ? num(meta.hwm) : -1;
        const fence = meta && meta.fence !== undefined ? num(meta.fence) : 0;
        const newHwm = Math.max(hwm, upToSeq); // SEED hwm so a migrated tail appends densely
        try {
          await iso
            .multi()
            .hSet(sk, String(upToSeq), toB64(bytes))
            .hSet(mk, "hwm", String(newHwm))
            .hSet(mk, "fence", String(fence))
            .exec();
          return true;
        } catch (e) {
          if (!isWatchError(e)) throw e;
          return false; // contended — retry
        }
      });
      if (done) return;
    }
  }

  async readLatestSnapshot(sessionId: string): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const h = await this.redis.hGetAll(snapKey(sessionId));
    let best = -1;
    for (const field of Object.keys(h ?? {})) {
      const upTo = num(field);
      if (upTo > best) best = upTo;
    }
    if (best < 0) return null;
    return { upToSeq: best, bytes: fromB64(h[String(best)]) };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    // Drop journal fields ≤ throughSeq; the hwm in iris_meta is untouched (seqs never
    // reused — the density check reads the stored hwm, which survives truncation).
    const jk = journalKey(sessionId);
    const h = await this.redis.hGetAll(jk);
    const drop = Object.keys(h ?? {}).filter((field) => num(field) <= throughSeq);
    if (drop.length > 0) await this.redis.hDel(jk, drop);
  }
}
