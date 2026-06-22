// MysqlStateStore — the StateStore port over MySQL/MariaDB. The crux is `append`: a
// single transaction that locks the per-session `iris_meta` row `FOR UPDATE` (the
// linearization point), checks the fence BEFORE the seq (stale_fence precedence), inserts
// the records, and bumps the hwm/fence — so concurrent writers are serialized and the
// journal stays dense and fenced. The direct analog of the Postgres store. Certified by
// @irisrun/store-conformance.
import type { StateStore, Version, CasResult, AppendResult, JournalRow } from "@irisrun/core";
import { type MysqlPool, rowsOf, headerOf, isDuplicateKey } from "./mysql.ts";

const toBuf = (u8: Uint8Array): Buffer => Buffer.from(u8);
const toU8 = (b: unknown): Uint8Array => new Uint8Array(b as Buffer);
// BIGINT may come back as a string on some driver configs; coerce. seqs/versions/fences
// are well within JS Number range (documented assumption, as in the Postgres store).
const num = (v: unknown): number => Number(v);

/** Pure: map a versioned-UPDATE outcome to a CasResult (affectedRows===1 ⇒ committed). */
export function versionedCasResult(affectedRows: number, expected: Version, currentVersion: number): CasResult {
  return affectedRows === 1 ? { ok: true, version: expected + 1 } : { ok: false, current: currentVersion };
}

export class MysqlStateStore implements StateStore {
  // Explicit field (NOT a constructor parameter property) — Node's strip-only TS mode,
  // which runs the test suite, does not support parameter properties.
  private readonly pool: MysqlPool;
  constructor(pool: MysqlPool) {
    this.pool = pool;
  }

  async load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const rows = rowsOf(await this.pool.query("SELECT version, bytes FROM iris_kv WHERE `key`=?", [key]));
    if (rows.length === 0) return null;
    return { bytes: toU8(rows[0].bytes), version: num(rows[0].version) };
  }

  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    if (expected === null) {
      try {
        await this.pool.query("INSERT INTO iris_kv (`key`, version, bytes) VALUES (?, 1, ?)", [key, toBuf(next)]);
        return { ok: true, version: 1 };
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        const rows = rowsOf(await this.pool.query("SELECT version FROM iris_kv WHERE `key`=?", [key]));
        return { ok: false, current: rows.length ? num(rows[0].version) : 0 };
      }
    }
    const res = headerOf(
      await this.pool.query("UPDATE iris_kv SET version=version+1, bytes=? WHERE `key`=? AND version=?", [toBuf(next), key, expected]),
    );
    if (res.affectedRows === 1) return { ok: true, version: expected + 1 };
    const rows = rowsOf(await this.pool.query("SELECT version FROM iris_kv WHERE `key`=?", [key]));
    return { ok: false, current: rows.length ? num(rows[0].version) : 0 };
  }

  async append(sessionId: string, expectedSeq: number, records: Uint8Array[], fence: Version): Promise<AppendResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // ensure a meta row, then lock it — the linearization point for concurrent writers
      await conn.query("INSERT IGNORE INTO iris_meta (session, hwm, fence) VALUES (?, -1, 0)", [sessionId]);
      const meta = rowsOf(await conn.query("SELECT hwm, fence FROM iris_meta WHERE session=? FOR UPDATE", [sessionId]));
      const storedFence = num(meta[0].fence);
      const hwm = num(meta[0].hwm);
      if (fence < storedFence) {
        await conn.rollback();
        return { ok: false, reason: "stale_fence", currentFence: storedFence };
      }
      if (hwm !== expectedSeq - 1) {
        await conn.rollback();
        return { ok: false, reason: "seq_conflict", currentSeq: hwm };
      }
      let seq = hwm;
      const tuples: string[] = [];
      const params: unknown[] = [];
      for (const bytes of records) {
        seq += 1;
        tuples.push("(?, ?, ?, ?)");
        params.push(sessionId, seq, toBuf(bytes), fence);
      }
      if (tuples.length > 0) {
        await conn.query(`INSERT INTO iris_journal (session, seq, bytes, fence) VALUES ${tuples.join(", ")}`, params);
      }
      await conn.query("UPDATE iris_meta SET hwm=?, fence=GREATEST(fence, ?) WHERE session=?", [seq, fence, sessionId]);
      await conn.commit();
      return { ok: true, seq };
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* the connection may already be aborted — ignore */
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const rows = rowsOf(
      await this.pool.query("SELECT seq, bytes FROM iris_journal WHERE session=? AND seq>=? ORDER BY seq", [sessionId, fromSeq]),
    );
    return rows.map((row) => ({ seq: num(row.seq), bytes: toU8(row.bytes) }));
  }

  async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "INSERT INTO iris_snapshot (session, upto_seq, bytes) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE bytes=VALUES(bytes)",
        [sessionId, upToSeq, toBuf(bytes)],
      );
      // SEED the hwm so a migrated tail (starting at upToSeq+1) appends densely
      await conn.query(
        "INSERT INTO iris_meta (session, hwm, fence) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE hwm=GREATEST(hwm, VALUES(hwm))",
        [sessionId, upToSeq],
      );
      await conn.commit();
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  async readLatestSnapshot(sessionId: string): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const rows = rowsOf(
      await this.pool.query("SELECT upto_seq, bytes FROM iris_snapshot WHERE session=? ORDER BY upto_seq DESC LIMIT 1", [sessionId]),
    );
    if (rows.length === 0) return null;
    return { upToSeq: num(rows[0].upto_seq), bytes: toU8(rows[0].bytes) };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    // rows ≤ throughSeq are dropped; the hwm in iris_meta is untouched (seqs never reused)
    await this.pool.query("DELETE FROM iris_journal WHERE session=? AND seq<=?", [sessionId, throughSeq]);
  }
}
