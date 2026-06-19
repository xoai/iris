// StateStore over node:sqlite (DatabaseSync — synchronous). Implements real
// compare-and-swap and an ATOMIC fenced append (spec §3.6, §4.2). node:sqlite
// is Node-only, which is why this lives in the host adapter, never in core.
import { DatabaseSync } from "node:sqlite";
import type {
  StateStore,
  CasResult,
  AppendResult,
  JournalRow,
  Version,
} from "@iris/core";
import { applySchema } from "./schema.ts";

/** Open (or create) a database file and apply the schema. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  applySchema(db);
  return db;
}

// node:sqlite returns BLOBs as Uint8Array; normalize defensively.
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error(`expected BLOB bytes from sqlite, got ${typeof v}`);
}

export class SqliteStateStore implements StateStore {
  protected db: DatabaseSync;

  // prepared statements (TS `private`/`protected` is erased at runtime, so the
  // testability subclass in cas.test.ts can still reach these).
  private kvGet;
  private kvUpdate;
  private kvInsert;
  private fenceGet;
  private fenceUpsert;
  private hwmGet;
  private hwmUpsert;
  private hwmSeed;
  private insertStmt;
  private journalSelect;
  private snapInsert;
  private snapLatest;
  private journalTruncate;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.kvGet = db.prepare("SELECT bytes, version FROM kv WHERE key = ?");
    this.kvUpdate = db.prepare(
      "UPDATE kv SET bytes = ?, version = ? WHERE key = ? AND version = ?",
    );
    this.kvInsert = db.prepare(
      "INSERT INTO kv (key, bytes, version) VALUES (?, ?, ?)",
    );
    this.fenceGet = db.prepare(
      "SELECT fence FROM journal_fence WHERE session_id = ?",
    );
    this.fenceUpsert = db.prepare(
      "INSERT INTO journal_fence (session_id, fence) VALUES (?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET fence = excluded.fence",
    );
    this.hwmGet = db.prepare(
      "SELECT max_seq FROM journal_hwm WHERE session_id = ?",
    );
    this.hwmUpsert = db.prepare(
      "INSERT INTO journal_hwm (session_id, max_seq) VALUES (?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET max_seq = excluded.max_seq",
    );
    // seed = advance to max(existing, value) — never lowers (used by writeSnapshot).
    this.hwmSeed = db.prepare(
      "INSERT INTO journal_hwm (session_id, max_seq) VALUES (?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)",
    );
    this.insertStmt = db.prepare(
      "INSERT INTO journal (session_id, seq, bytes, fence) VALUES (?, ?, ?, ?)",
    );
    this.journalSelect = db.prepare(
      "SELECT seq, bytes FROM journal WHERE session_id = ? AND seq >= ? ORDER BY seq ASC",
    );
    this.snapInsert = db.prepare(
      "INSERT INTO snapshots (session_id, up_to_seq, bytes) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id, up_to_seq) DO UPDATE SET bytes = excluded.bytes",
    );
    this.snapLatest = db.prepare(
      "SELECT up_to_seq, bytes FROM snapshots WHERE session_id = ? ORDER BY up_to_seq DESC LIMIT 1",
    );
    this.journalTruncate = db.prepare(
      "DELETE FROM journal WHERE session_id = ? AND seq <= ?",
    );
  }

  async load(
    key: string,
  ): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const row = this.kvGet.get(key) as
      | { bytes: unknown; version: number }
      | undefined;
    if (!row) return null;
    return { bytes: toBytes(row.bytes), version: row.version };
  }

  async cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult> {
    const row = this.kvGet.get(key) as { version: number } | undefined;
    const curVer = row ? row.version : null;
    if (curVer !== expected) return { ok: false, current: curVer ?? 0 };
    if (curVer === null) {
      this.kvInsert.run(key, next, 1);
      return { ok: true, version: 1 };
    }
    const version = curVer + 1;
    this.kvUpdate.run(next, version, key, curVer);
    return { ok: true, version };
  }

  // Seam for the rollback/atomicity test: overridable so a subclass can inject
  // a mid-batch failure and assert the BEGIN IMMEDIATE transaction rolls back.
  protected insertRecord(
    sessionId: string,
    seq: number,
    bytes: Uint8Array,
    fence: Version,
  ): void {
    this.insertStmt.run(sessionId, seq, bytes, fence);
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    // Atomic: fence check + seq check + inserts + fence bump in ONE immediate
    // transaction. No interleave window (spec §3.6).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const fenceRow = this.fenceGet.get(sessionId) as
        | { fence: number }
        | undefined;
      const storedFence = fenceRow ? fenceRow.fence : 0;
      if (fence < storedFence) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "stale_fence", currentFence: storedFence };
      }

      const hwmRow = this.hwmGet.get(sessionId) as
        | { max_seq: number }
        | undefined;
      const lastSeq = hwmRow ? hwmRow.max_seq : -1;
      if (lastSeq !== expectedSeq - 1) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "seq_conflict", currentSeq: lastSeq };
      }

      let seq = lastSeq;
      for (const bytes of records) {
        seq += 1;
        this.insertRecord(sessionId, seq, bytes, fence);
      }
      this.hwmUpsert.run(sessionId, seq);
      this.fenceUpsert.run(sessionId, Math.max(storedFence, fence));
      this.db.exec("COMMIT");
      return { ok: true, seq };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back / not in a transaction — ignore
      }
      throw err;
    }
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const rows = this.journalSelect.all(sessionId, fromSeq) as Array<{
      seq: number;
      bytes: unknown;
    }>;
    return rows.map((r) => ({ seq: r.seq, bytes: toBytes(r.bytes) }));
  }

  async writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    this.snapInsert.run(sessionId, upToSeq, bytes);
    // Seed the high-water mark (spec §3.4). Normal callers pass upToSeq === hwm
    // (no-op); the only caller with upToSeq > hwm is migration seeding an empty
    // destination, so the migrated tail (from upToSeq+1) passes the density check.
    this.hwmSeed.run(sessionId, upToSeq);
  }

  async readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const row = this.snapLatest.get(sessionId) as
      | { up_to_seq: number; bytes: unknown }
      | undefined;
    if (!row) return null;
    return { upToSeq: row.up_to_seq, bytes: toBytes(row.bytes) };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    this.journalTruncate.run(sessionId, throughSeq);
  }

  /** Close the underlying database handle. A long-lived host should call this
   *  on shutdown; a one-shot process can rely on exit to reclaim it. */
  close(): void {
    this.db.close();
  }
}
