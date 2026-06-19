// The two host ports (spec §4.2, §4.3; framework Spec 00 §ports). The core
// depends only on these; host adapters implement them. Types only.

export type Version = number; // monotonic per key — the fencing token

export type CasResult =
  | { ok: true; version: Version }
  | { ok: false; current: Version };

export type AppendResult =
  | { ok: true; seq: number }
  | { ok: false; reason: "seq_conflict"; currentSeq: number }
  | { ok: false; reason: "stale_fence"; currentFence: Version };

export interface JournalRow {
  seq: number;
  bytes: Uint8Array;
}

export interface StateStore {
  // Generic key/value with compare-and-swap (used for the single-writer lease).
  load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null>;
  cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult>;

  // Journal: atomic, dense, fenced append. The fence check, the expectedSeq
  // check, and the insert MUST be one atomic operation (spec §3.6).
  append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult>;
  readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]>;

  // Snapshots: bound replay cost (spec §3.7).
  writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void>;
  readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null>;
  truncateJournal(sessionId: string, throughSeq: number): Promise<void>;
}

export interface Scheduler {
  sleepUntil(sessionId: string, wakeAt: number): Promise<void>; // durable timer (logical time)
  waitForSignal(sessionId: string, name: string): Promise<void>; // external event
  signal(sessionId: string, name: string, payload?: Uint8Array): Promise<void>;
}
