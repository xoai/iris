// A real in-memory StateStore enforcing the SAME invariants as the SQLite store:
// CAS on the kv/lease key, atomic fenced append, dense seq, and a high-water mark
// that survives truncation. NO test backdoors — this is a production port impl
// (the brief sanctions an in-memory store "as a port impl that still enforces
// CAS"), used as store B for cross-store resume and as a fast unit store.
import type {
  StateStore,
  CasResult,
  AppendResult,
  JournalRow,
  Version,
} from "@irisrun/core";

export class MemoryStateStore implements StateStore {
  private kv = new Map<string, { bytes: Uint8Array; version: Version }>();
  private journals = new Map<string, JournalRow[]>();
  private fences = new Map<string, Version>();
  private hwm = new Map<string, number>(); // highest seq ever appended (survives truncation)
  private snapshots = new Map<string, { upToSeq: number; bytes: Uint8Array }>();

  async load(
    key: string,
  ): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const e = this.kv.get(key);
    return e ? { bytes: e.bytes, version: e.version } : null;
  }

  async cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult> {
    const cur = this.kv.get(key);
    const curVer = cur ? cur.version : null;
    if (curVer !== expected) return { ok: false, current: curVer ?? 0 };
    const version = (curVer ?? 0) + 1;
    this.kv.set(key, { bytes: next, version });
    return { ok: true, version };
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    const storedFence = this.fences.get(sessionId) ?? 0;
    if (fence < storedFence) {
      return { ok: false, reason: "stale_fence", currentFence: storedFence };
    }
    // density check uses the high-water mark, NOT MAX(rows) — truncation must
    // not let seq numbers be reused.
    const last = this.hwm.get(sessionId) ?? -1;
    if (last !== expectedSeq - 1) {
      return { ok: false, reason: "seq_conflict", currentSeq: last };
    }
    const j = this.journals.get(sessionId) ?? [];
    let seq = last;
    for (const bytes of records) {
      seq += 1;
      j.push({ seq, bytes });
    }
    this.journals.set(sessionId, j);
    this.hwm.set(sessionId, seq);
    this.fences.set(sessionId, Math.max(storedFence, fence));
    return { ok: true, seq };
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const j = this.journals.get(sessionId) ?? [];
    return j
      .filter((r) => r.seq >= fromSeq)
      .map((r) => ({ seq: r.seq, bytes: r.bytes }));
  }

  async writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    this.snapshots.set(sessionId, { upToSeq, bytes });
    // Seed the high-water mark. Normal callers pass upToSeq === hwm
    // (no-op); the only caller with upToSeq > hwm is migration seeding an empty
    // destination, which needs hwm advanced so the migrated tail (starting at
    // upToSeq+1) satisfies the density check.
    this.hwm.set(sessionId, Math.max(this.hwm.get(sessionId) ?? -1, upToSeq));
  }

  async readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    return this.snapshots.get(sessionId) ?? null;
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    const j = this.journals.get(sessionId) ?? [];
    this.journals.set(
      sessionId,
      j.filter((r) => r.seq > throughSeq),
    );
  }
}
