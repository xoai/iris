// Chaos & concurrency helpers. Exercises the durability
// spine (CAS, fencing, dense journal, snapshot+tail recovery, migration) against
// the REAL persistence backends — @irisrun/store-fs (a real temp dir on disk) and
// @irisrun/store-sqlite (a real temp .sqlite file) — which are production code,
// NOT the in-memory fake. "Real hosts" here means real persistence + a simulated
// co-located process-restart/partition; the literally-distributed multi-host run
// (live Cloudflare DO + a VPS) is a documented residual, not faked here. Only the
// STORE is the real backend; the scheduler is in-memory (the durability spine
// under test lives in the store, not the durable-timer substrate).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  StateStore,
  AppendResult,
  EngineDeps,
  Program,
  PerformerRegistry,
  Json,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
} from "@irisrun/core";
import { decode } from "@irisrun/core";
import { FsStateStore } from "@irisrun/store-fs";
import { SqliteStateStore, openDatabase } from "@irisrun/store-sqlite";
import { MemScheduler, TestClock } from "./mem-store.ts";

// ── real backends ────────────────────────────────────────────────────────────
// open() returns a store over the SAME backing data each call, so a "redeploy" =
// release(store) then open(). cleanup() deletes the backing files.
export interface ChaosBackend {
  label: string;
  open(): StateStore;
  release(store: StateStore): void;
  cleanup(): void;
}

export function fsBackend(): ChaosBackend {
  const root = mkdtempSync(join(tmpdir(), "iris-chaos-fs-"));
  return {
    label: "fs",
    open: () => new FsStateStore({ root }),
    release: () => {}, // fs holds no long-lived handle
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function sqliteBackend(): ChaosBackend {
  const dir = mkdtempSync(join(tmpdir(), "iris-chaos-sqlite-"));
  const path = join(dir, "db.sqlite");
  return {
    label: "sqlite",
    open: () => new SqliteStateStore(openDatabase(path)),
    release: (s) => (s as unknown as { close(): void }).close(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const REAL_BACKENDS: Array<() => ChaosBackend> = [fsBackend, sqliteBackend];

// ── windowed fault injector ──────────────────────────────────────────────────
// Wraps a real store and fails the next `appendFailures.length` append() calls
// with the queued reasons (then heals, delegating to the real store). Can emit
// BOTH `stale_fence` (→ aborted/lease_lost) and `seq_conflict` (→ aborted/
// seq_conflict). cas/reads/snapshots always delegate, so a retry can re-acquire
// the lease and make progress. Generalizes tests/lib/flaky-store.ts (which fires
// once / is permanent) to a bounded partition window.
export type FailReason = "stale_fence" | "seq_conflict";

export function windowedFaultStore(
  inner: StateStore,
  appendFailures: FailReason[],
): { store: StateStore; state: { fired: number } } {
  const queue = [...appendFailures];
  const state = { fired: 0 };
  const store: StateStore = {
    load: (k) => inner.load(k),
    cas: (k, e, n) => inner.cas(k, e, n),
    append: async (sid, seq, recs, fence): Promise<AppendResult> => {
      const reason = queue.shift();
      if (reason) {
        state.fired += 1;
        return reason === "stale_fence"
          ? { ok: false, reason: "stale_fence", currentFence: fence + 100 }
          : { ok: false, reason: "seq_conflict", currentSeq: seq + 100 };
      }
      return inner.append(sid, seq, recs, fence);
    },
    readJournal: (s, f) => inner.readJournal(s, f),
    writeSnapshot: (s, u, b) => inner.writeSnapshot(s, u, b),
    readLatestSnapshot: (s) => inner.readLatestSnapshot(s),
    truncateJournal: (s, t) => inner.truncateJournal(s, t),
  };
  return { store, state };
}

// ── deps builder (real store + in-memory scheduler/clock) ────────────────────
export function chaosDeps<S extends Json>(
  store: StateStore,
  program: Program<S>,
  performers: PerformerRegistry,
  opts: { holderId?: string; snapshotThreshold?: number; keepHistory?: boolean } = {},
): EngineDeps<S> {
  return {
    store,
    scheduler: new MemScheduler(),
    clock: new TestClock(1),
    program,
    performers,
    defDigest: "d",
    holderId: opts.holderId ?? "H",
    assertReplay: true,
    snapshotThreshold: opts.snapshotThreshold,
    keepHistory: opts.keepHistory,
  };
}

// ── multiParkProgram: n echo(+1) effects, parking on a timer after EACH, then
// finish. Yields n+1 turns so a redeploy/partition can be injected BETWEEN turns
// (the long determinism-under-chaos run). Output: { total: n }. ──────────────
export interface MPState extends Record<string, Json> {
  total: number;
  count: number;
  phase: string; // run | afterEffect | parked | done
}
export function multiParkProgram(n: number): Program<MPState> {
  return {
    initial: { total: 0, count: 0, phase: "run" },
    reducer: (state, r: JournalRecord): MPState => {
      if (r.kind === "effect_result") {
        const p = r.payload as EffectResult;
        if (p.outcome.ok && typeof p.outcome.value === "number") {
          return { ...state, total: state.total + p.outcome.value, count: state.count + 1, phase: "afterEffect" };
        }
        return state;
      }
      if (r.kind === "marker") {
        const m = r.payload as Marker;
        if (m.marker === "wait") return { ...state, phase: "parked" };
        if (m.marker === "finish") return { ...state, phase: "done" };
      }
      return state;
    },
    step: (state): Action => {
      if (state.count >= n) return { type: "finish", output: { total: state.total } };
      // just performed an effect → park; otherwise (start | parked) → next effect
      if (state.phase === "afterEffect") return { type: "wait", wait: { kind: "timer", at: 100 * (state.count + 1) } };
      return { type: "effect", effectKind: "echo", request: 1, idempotencyKey: `k${state.count}` };
    },
  };
}

// ── journal inspection ───────────────────────────────────────────────────────
export async function readRecords(store: StateStore, sid: string): Promise<JournalRecord[]> {
  const rows = await store.readJournal(sid, 0);
  return rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
}

// Dense iff the read rows are gap-free and strictly increasing in seq.
export async function assertDenseJournal(
  store: StateStore,
  sid: string,
  assert: (cond: unknown, msg?: string) => void,
): Promise<void> {
  const rows = await store.readJournal(sid, 0);
  for (let i = 1; i < rows.length; i++) {
    assert(rows[i].seq === rows[i - 1].seq + 1, `journal must be dense: seq gap at index ${i}`);
  }
}

export function countEffectResults(records: JournalRecord[]): number {
  return records.filter((r) => r.kind === "effect_result").length;
}
