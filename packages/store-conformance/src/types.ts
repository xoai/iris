// Types for the portable store/scheduler conformance suite. Depends only on the
// two core ports — never on a concrete store — so it certifies first- and
// third-party adapters identically.
import type { StateStore, Scheduler } from "@irisrun/core";

/** One conformance check. `fn` throws (via node:assert) on failure. The harness
 *  returns these and never imports a test runner, so a caller wires them into
 *  `node:test` (see `register`) or iterates them under any runner. */
export interface ConformanceCase {
  name: string;
  fn: () => Promise<void>;
}

/** Build a FRESH store for each case (so every check starts from clean state). */
export type StoreFactory = () => StateStore | Promise<StateStore>;

/** A peek→confirm wakeup, exactly as every shipped scheduler exposes it. This is
 *  a HOST-side concern, NOT on the core `Scheduler` port (which has only
 *  sleepUntil/waitForSignal/signal) — defined here so the harness can certify the
 *  at-least-once wakeup protocol structurally. */
export interface Wakeup {
  sessionId: string;
  kind: "timer" | "signal";
  name?: string;
}

export interface WakeupSource {
  dueWakeups(now: number): Wakeup[] | Promise<Wakeup[]>;
  confirmWoken(sessionId: string, now: number): void | Promise<void>;
}

/** A scheduler under test = the core `Scheduler` + the host-side `WakeupSource`. */
export type SchedulerUnderTest = Scheduler & WakeupSource;
export type SchedulerFactory = () => SchedulerUnderTest | Promise<SchedulerUnderTest>;

export interface StoreConformanceOpts {
  /** Opt-in real-concurrency stress: fire N racers at the same CAS / append.
   *  Default off. A single-threaded backend simply confirms serialized
   *  behaviour; a racy / eventually-consistent backend FAILS here (more than one
   *  winner) — this is where weak consistency is actually caught. */
  concurrency?: number;
}
