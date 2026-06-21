// PostgresStateStore — the StateStore port over PostgreSQL. The crux is `append`: a
// single transaction that locks the per-session `iris_meta` row `FOR UPDATE` (the
// linearization point), checks the fence BEFORE the seq (stale_fence precedence),
// inserts the records, and bumps the hwm/fence — so concurrent writers are serialized
// and the journal stays dense and fenced. Certified by @irisrun/store-conformance.
import type { StateStore, Version, CasResult, AppendResult, JournalRow } from "@irisrun/core";
import type { PgPool } from "./pg.ts";

const toBuf = (u8: Uint8Array): Buffer => Buffer.from(u8);
const toU8 = (b: unknown): Uint8Array => new Uint8Array(b as Buffer);
// pg returns `bigint` columns as strings by default; seqs/versions/fences are well
// within JS Number range (documented assumption).
const num = (v: unknown): number => Number(v);

export class PostgresStateStore implements StateStore {
  constructor(private readonly pool: PgPool) {}

  async load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const r = await this.pool.query("SELECT version, bytes FROM iris_kv WHERE key=$1", [key]);
    if (r.rows.length === 0) return null;
    return { bytes: toU8(r.rows[0].bytes), version: num(r.rows[0].version) };
  }

  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    if (expected === null) {
      const ins = await this.pool.query(
        "INSERT INTO iris_kv (key, version, bytes) VALUES ($1, 1, $2) ON CONFLICT (key) DO NOTHING RETURNING version",
        [key, toBuf(next)],
      );
      if (ins.rows.length > 0) return { ok: true, version: 1 };
      const cur = await this.pool.query("SELECT version FROM iris_kv WHERE key=$1", [key]);
      return { ok: false, current: cur.rows.length ? num(cur.rows[0].version) : 0 };
    }
    const upd = await this.pool.query(
      "UPDATE iris_kv SET version=version+1, bytes=$3 WHERE key=$1 AND version=$2 RETURNING version",
      [key, expected, toBuf(next)],
    );
    if (upd.rows.length > 0) return { ok: true, version: num(upd.rows[0].version) };
    const cur = await this.pool.query("SELECT version FROM iris_kv WHERE key=$1", [key]);
    return { ok: false, current: cur.rows.length ? num(cur.rows[0].version) : 0 };
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // ensure a meta row, then lock it — the linearization point for concurrent writers
      await client.query(
        "INSERT INTO iris_meta (session, hwm, fence) VALUES ($1, -1, 0) ON CONFLICT (session) DO NOTHING",
        [sessionId],
      );
      const meta = await client.query("SELECT hwm, fence FROM iris_meta WHERE session=$1 FOR UPDATE", [sessionId]);
      const storedFence = num(meta.rows[0].fence);
      const hwm = num(meta.rows[0].hwm);
      if (fence < storedFence) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "stale_fence", currentFence: storedFence };
      }
      if (hwm !== expectedSeq - 1) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "seq_conflict", currentSeq: hwm };
      }
      let seq = hwm;
      const tuples: string[] = [];
      const params: unknown[] = [];
      for (const bytes of records) {
        seq += 1;
        const i = params.length;
        tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
        params.push(sessionId, seq, toBuf(bytes), fence);
      }
      if (tuples.length > 0) {
        await client.query(`INSERT INTO iris_journal (session, seq, bytes, fence) VALUES ${tuples.join(", ")}`, params);
      }
      await client.query("UPDATE iris_meta SET hwm=$2, fence=GREATEST(fence, $3) WHERE session=$1", [sessionId, seq, fence]);
      await client.query("COMMIT");
      return { ok: true, seq };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the connection may already be aborted — ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const r = await this.pool.query(
      "SELECT seq, bytes FROM iris_journal WHERE session=$1 AND seq>=$2 ORDER BY seq",
      [sessionId, fromSeq],
    );
    return r.rows.map((row) => ({ seq: num(row.seq), bytes: toU8(row.bytes) }));
  }

  async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO iris_snapshot (session, upto_seq, bytes) VALUES ($1, $2, $3) ON CONFLICT (session, upto_seq) DO UPDATE SET bytes=EXCLUDED.bytes",
        [sessionId, upToSeq, toBuf(bytes)],
      );
      // SEED the hwm so a migrated tail (starting at upToSeq+1) appends densely
      await client.query(
        "INSERT INTO iris_meta (session, hwm, fence) VALUES ($1, $2, 0) ON CONFLICT (session) DO UPDATE SET hwm=GREATEST(iris_meta.hwm, $2)",
        [sessionId, upToSeq],
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async readLatestSnapshot(sessionId: string): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const r = await this.pool.query(
      "SELECT upto_seq, bytes FROM iris_snapshot WHERE session=$1 ORDER BY upto_seq DESC LIMIT 1",
      [sessionId],
    );
    if (r.rows.length === 0) return null;
    return { upToSeq: num(r.rows[0].upto_seq), bytes: toU8(r.rows[0].bytes) };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    // rows ≤ throughSeq are dropped; the hwm in iris_meta is untouched (seqs never reused)
    await this.pool.query("DELETE FROM iris_journal WHERE session=$1 AND seq<=$2", [sessionId, throughSeq]);
  }
}
