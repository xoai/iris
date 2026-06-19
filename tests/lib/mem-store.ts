// In-memory port implementations for fast unit tests. These STILL enforce CAS
// and fencing exactly like the SQLite store — they never bypass determinism/CAS
// checks (spec §2). Used by Tasks 7–12.
import type {
  StateStore,
  Scheduler,
  Version,
  CasResult,
  AppendResult,
  JournalRow,
  LogicalClock,
} from "@iris/core";

export class MemStateStore implements StateStore {
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
    const j = this.journals.get(sessionId) ?? [];
    // density check uses the high-water mark, NOT MAX(rows) — truncation must
    // not let seq numbers be reused.
    const last = this.hwm.get(sessionId) ?? -1;
    if (last !== expectedSeq - 1) {
      return { ok: false, reason: "seq_conflict", currentSeq: last };
    }
    // atomic commit (single-threaded JS — no interleave possible)
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

  /** Test helper: simulate another writer advancing the journal out-of-band. */
  forceAppendRaw(sessionId: string, bytes: Uint8Array, fence: Version): number {
    const j = this.journals.get(sessionId) ?? [];
    const seq = (this.hwm.get(sessionId) ?? -1) + 1;
    j.push({ seq, bytes });
    this.journals.set(sessionId, j);
    this.hwm.set(sessionId, seq);
    this.fences.set(sessionId, Math.max(this.fences.get(sessionId) ?? 0, fence));
    return seq;
  }

  /** Test helper: simulate a higher-fence takeover (without consuming a seq). */
  forceFence(sessionId: string, fence: Version): void {
    this.fences.set(sessionId, fence);
  }
}

export class MemScheduler implements Scheduler {
  timers: Array<{ sessionId: string; wakeAt: number }> = [];
  waits: Array<{ sessionId: string; name: string }> = [];
  signals: Array<{ sessionId: string; name: string; payload?: Uint8Array }> = [];

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    this.timers.push({ sessionId, wakeAt });
  }
  async waitForSignal(sessionId: string, name: string): Promise<void> {
    this.waits.push({ sessionId, name });
  }
  async signal(
    sessionId: string,
    name: string,
    payload?: Uint8Array,
  ): Promise<void> {
    this.signals.push({ sessionId, name, payload });
  }
}

export class TestClock implements LogicalClock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(by: number): number {
    this.t += by;
    return this.t;
  }
}
