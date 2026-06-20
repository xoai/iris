// P2-9 (C6, A-3, A-4) — the schedule PUMP drives a recurring job end-to-end over durable
// timers. A-3: N cycles fire, the session parks between cycles, the whole session replays
// identically. A-4: an aborted resume does NOT consume its wakeup (at-least-once) — it
// re-fires on the next tick. Plus the T3.2 compile-time guard that concrete schedulers
// satisfy WakeupSource.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnOn } from "@iris/host";
import type { HostAdapter } from "@iris/host";
import { replay } from "@iris/core";
import type { PerformerRegistry, Json, LogicalClock } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { SqliteScheduler } from "@iris/store-sqlite";
import { makeScheduleRunner, scheduleProgram, type WakeupSource, type ResumeInputs } from "@iris/schedule";
import type { ScheduleState } from "@iris/schedule";
import { makeAbortOnAppendStore, makeContendedStore } from "./lib/flaky-store.ts";

// ── T3.2 compile-time guard: concrete schedulers satisfy the host WakeupSource ──────────
type AssertAssignable<T extends WakeupSource> = T;
type _MemIsSource = AssertAssignable<MemoryScheduler>;
type _SqliteIsSource = AssertAssignable<SqliteScheduler>;

const INTERVAL = 10;
const SID = "sched-1";

function inputsAt(now: number, maxRuns: number): {
  defDigest: string;
  program: ReturnType<typeof scheduleProgram>;
  performers: PerformerRegistry;
  clock: LogicalClock;
} {
  // The per-tick clock backs BOTH the engine and the `clock` performer, so the cycle reads
  // exactly `now` (spec §5.3).
  const clock: LogicalClock = { now: () => now };
  return {
    defDigest: "sched-def",
    program: scheduleProgram({ intervalTicks: INTERVAL, maxRuns, job: { effectKind: "echo", request: { tick: true } } }),
    performers: {
      clock: async () => ({ ok: true, value: clock.now() }),
      echo: async (req: Json) => ({ ok: true, value: req }),
    },
    clock,
  };
}

test("A-3: the pump drives N cycles over durable timers; the session replays identically", async () => {
  const maxRuns = 3;
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const host: HostAdapter = { name: "sched-host", capabilities: { long_running: true }, store, scheduler };
  const resumeInputs: ResumeInputs = (_sid, now) => inputsAt(now, maxRuns);
  const runner = makeScheduleRunner({ host, source: scheduler, resumeInputs });

  // Cycle 1: start the schedule (logical time 0). It runs the job and parks on a timer @10.
  const start = await runTurnOn(host, { sessionId: SID, ...inputsAt(0, maxRuns) });
  assert.equal(start.status, "parked");
  assert.deepEqual(start.status === "parked" ? start.wait : null, { kind: "timer", at: INTERVAL });

  // Not due before the timer.
  assert.deepEqual(await runner.tick(5), { fired: [], skipped: [] });

  // Cycle 2 @10 (parks @20), Cycle 3 @20 (finishes at maxRuns).
  const t10 = await runner.tick(10);
  assert.deepEqual(t10.fired, [{ sessionId: SID, status: "parked" }]);
  const t20 = await runner.tick(20);
  assert.deepEqual(t20.fired, [{ sessionId: SID, status: "finished" }]);

  // After the final cycle nothing is due (the wakeup was confirmed; no new park).
  assert.deepEqual(await runner.tick(30), { fired: [], skipped: [] });

  // The whole session replays identically to runs=maxRuns, finished.
  const rows = await store.readJournal(SID, 0);
  const records = rows.map((r) => JSON.parse(Buffer.from(r.bytes).toString("utf8")) as Json);
  const prog = scheduleProgram({ intervalTicks: INTERVAL, maxRuns, job: { effectKind: "echo", request: { tick: true } } });
  const a = replay(prog.initial, records as never[], prog.reducer);
  const b = replay(prog.initial, records as never[], prog.reducer);
  assert.deepEqual(a, b, "schedule session replays deterministically");
  assert.equal((a as ScheduleState).runs, maxRuns);
  assert.equal((a as ScheduleState).phase, "done");
});

test("A-3: an unowned due session (resumeInputs → null) is skipped, NOT confirmed", async () => {
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const host: HostAdapter = { name: "sched-host", capabilities: { long_running: true }, store, scheduler };
  // Park a session on a timer, then run a pump that doesn't own it.
  await runTurnOn(host, { sessionId: SID, ...inputsAt(0, 3) });
  const runner = makeScheduleRunner({ host, source: scheduler, resumeInputs: () => null });
  const out = await runner.tick(10);
  assert.deepEqual(out, { fired: [], skipped: [SID] });
  // Left unconfirmed for its real owner — still due.
  assert.ok(scheduler.dueWakeups(10).some((w) => w.sessionId === SID), "skipped wakeup is not consumed");
});

test("A-4: an aborted resume does NOT consume its wakeup — it re-fires next tick", async () => {
  const underlying = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const plainHost: HostAdapter = { name: "h", capabilities: { long_running: true }, store: underlying, scheduler };

  // Cycle 1 commits and parks @10 on the healthy store.
  await runTurnOn(plainHost, { sessionId: SID, ...inputsAt(0, 5) });

  // A pump whose store fails the NEXT append once → the @10 resume aborts mid-turn.
  const { store: abortStore } = makeAbortOnAppendStore(underlying);
  const abortHost: HostAdapter = { name: "h", capabilities: { long_running: true }, store: abortStore, scheduler };
  const runner = makeScheduleRunner({ host: abortHost, source: scheduler, resumeInputs: (_s, now) => inputsAt(now, 5) });

  const aborted = await runner.tick(10);
  assert.deepEqual(aborted.fired, [{ sessionId: SID, status: "aborted" }]);
  assert.ok(scheduler.dueWakeups(10).some((w) => w.sessionId === SID), "aborted wakeup left to re-fire (at-least-once)");

  // The wrapper's one injected failure is spent → the retry commits and confirms.
  const retried = await runner.tick(10);
  assert.equal(retried.fired[0]?.status, "parked", "the re-fired resume now commits");
  assert.ok(!scheduler.dueWakeups(10).some((w) => w.sessionId === SID), "now consumed after a committed turn");
});

test("A-4: a contended resume (lease unavailable) is NOT confirmed — only finished/parked commit", async () => {
  const underlying = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const plainHost: HostAdapter = { name: "h", capabilities: { long_running: true }, store: underlying, scheduler };

  // Cycle 1 commits and parks @10.
  await runTurnOn(plainHost, { sessionId: SID, ...inputsAt(0, 5) });

  // A pump whose store can never acquire the lease → every resume is `contended` (no turn
  // ran, nothing journaled). The wakeup must NOT be consumed (it would orphan the session).
  const contendedHost: HostAdapter = { name: "h", capabilities: { long_running: true }, store: makeContendedStore(underlying), scheduler };
  const runner = makeScheduleRunner({ host: contendedHost, source: scheduler, resumeInputs: (_s, now) => inputsAt(now, 5) });

  const out = await runner.tick(10);
  assert.equal(out.fired[0]?.status, "contended");
  assert.ok(scheduler.dueWakeups(10).some((w) => w.sessionId === SID), "contended wakeup left to re-fire (at-least-once)");
});
