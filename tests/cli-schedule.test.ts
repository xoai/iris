// C4 — `iris schedule`: a recurring, durably-replayable job reachable
// from the CLI. cmdSchedule drives scheduleProgram + makeScheduleRunner over an injected
// host (the demo.ts shape, but as the testable command). Proves: the job runs exactly
// `maxRuns` cycles and completes; a second run over a FRESH store replays byte-identically
// (the journal digest matches); loud failure on a non-positive interval/max-runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, decode } from "@irisrun/core";
import type { PerformerRegistry, Json } from "@irisrun/core";
import type { HostAdapter } from "@irisrun/host";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { cmdSchedule } from "iris-runtime";

// One cycle's performers: a `clock` bound to `now` + the job's `echo` performer
// (deterministic, no key — exactly the demo's schedule wiring).
function cyclePerformers(now: number): PerformerRegistry {
  return {
    clock: async () => ({ ok: true, value: now }),
    echo: async (r: Json) => ({ ok: true, value: r }),
  };
}

function freshHost(): { host: HostAdapter; store: MemoryStateStore; scheduler: MemoryScheduler } {
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  return { host: { name: "iris-schedule", capabilities: { long_running: true }, store, scheduler }, store, scheduler };
}

async function run(sessionId: string): Promise<{ store: MemoryStateStore; result: Awaited<ReturnType<typeof cmdSchedule>> }> {
  const { host, store, scheduler } = freshHost();
  const result = await cmdSchedule({
    host,
    source: scheduler,
    sessionId,
    intervalTicks: 10,
    maxRuns: 3,
    ticks: 3,
    job: { effectKind: "echo", request: { ping: true } },
    cyclePerformers,
  });
  return { store, result };
}

async function journalDigest(store: MemoryStateStore, sessionId: string): Promise<string> {
  const rows = await store.readJournal(sessionId, 0);
  return canonicalize(rows.map((r) => decode(r.bytes)));
}

test("cmdSchedule: runs maxRuns cycles on durable timers and completes", async () => {
  const { result } = await run("job-1");
  // start (cycle 1 @ t=0) parks on a timer; each tick resumes the next cycle; the 3rd
  // run reaches maxRuns → finished.
  assert.ok(result.cycles.length >= 3, `expected ≥3 committed cycles, got ${result.cycles.length}`);
  assert.equal(result.cycles[0].now, 0);
  const finished = result.cycles.filter((c) => c.status === "finished");
  assert.equal(finished.length, 1, "the schedule completes exactly once (at maxRuns)");
  assert.match(result.text, /"status":"finished"/);
});

test("cmdSchedule: a second run over a fresh store replays byte-identically (deterministic)", async () => {
  const a = await run("job-A");
  const b = await run("job-B"); // a different sessionId, but the journal content is id-independent here
  const da = await journalDigest(a.store, "job-A");
  const db = await journalDigest(b.store, "job-B");
  assert.equal(da, db, "two independent runs of the same schedule produce byte-identical journals");
  assert.deepEqual(
    a.result.cycles.map((c) => c.status),
    b.result.cycles.map((c) => c.status),
  );
});

test("cmdSchedule: a non-positive interval/max-runs fails LOUDLY", async () => {
  const { host, scheduler } = freshHost();
  const base = { host, source: scheduler, sessionId: "j", ticks: 1, job: { effectKind: "echo" as const, request: {} }, cyclePerformers };
  await assert.rejects(() => cmdSchedule({ ...base, intervalTicks: 0, maxRuns: 3 }), /intervalTicks/);
  await assert.rejects(() => cmdSchedule({ ...base, intervalTicks: 10, maxRuns: 0 }), /maxRuns/);
  await assert.rejects(() => cmdSchedule({ ...base, intervalTicks: 10, maxRuns: 3, ticks: -1 }), /ticks/);
});
