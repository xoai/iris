// P2-9 (C5) — scheduleProgram is a PURE Program: deterministic cadence from journaled
// clock reads, maxRuns termination, job-failure folds without throwing, and replay identity
// (folding the same records twice yields the same state). No engine, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "@irisrun/core";
import type { JournalRecord, Json } from "@irisrun/core";
import { scheduleProgram } from "@irisrun/schedule";

// Minimal record builders — the reducer reads only `kind` + `payload`. effectId must be
// UNIQUE per record: replay (replay.ts) dedupes effect_results by effectId (first wins), so
// reusing an id across cycles would silently drop the later cycle's result.
function clockResult(value: number, seq = 1): JournalRecord {
  return { seq, ts: 0, defDigest: "d", kind: "effect_result", payload: { effectId: `clock:${seq}`, outcome: { ok: true, value } } };
}
function jobResult(value: Json, seq = 2): JournalRecord {
  return { seq, ts: 0, defDigest: "d", kind: "effect_result", payload: { effectId: `echo:${seq}`, outcome: { ok: true, value } } };
}
function jobFailure(message: string, seq = 2): JournalRecord {
  return { seq, ts: 0, defDigest: "d", kind: "effect_result", payload: { effectId: `echo:${seq}`, outcome: { ok: false, error: { message } } } };
}
function waitMarker(at: number): JournalRecord {
  return { seq: 0, ts: 0, defDigest: "d", kind: "marker", payload: { marker: "wait", wait: { kind: "timer", at } } };
}
function finishMarker(): JournalRecord {
  return { seq: 0, ts: 0, defDigest: "d", kind: "marker", payload: { marker: "finish" } };
}

const JOB: Json = { echoed: true };

test("scheduleProgram: step emits clock → job → timer-park, then finish at maxRuns", () => {
  const p = scheduleProgram({ intervalTicks: 10, maxRuns: 2, job: { effectKind: "echo", request: JOB } });
  // initial → read_clock emits a clock effect
  const a0 = p.step(p.initial);
  assert.equal(a0.type, "effect");
  assert.equal(a0.type === "effect" ? a0.effectKind : null, "clock");

  // after a clock read of 100, cadence is 100+10
  const s1 = p.reducer(p.initial, clockResult(100));
  assert.deepEqual({ now: s1.now, nextAt: s1.nextAt, phase: s1.phase }, { now: 100, nextAt: 110, phase: "run_job" });
  const a1 = p.step(s1);
  assert.equal(a1.type === "effect" ? a1.effectKind : null, "echo");

  // first job → runs:1 < maxRuns:2 → park on the timer at nextAt
  const s2 = p.reducer(s1, jobResult(JOB));
  assert.equal(s2.runs, 1);
  assert.equal(s2.phase, "park");
  const a2 = p.step(s2);
  assert.deepEqual(a2.type === "wait" ? a2.wait : null, { kind: "timer", at: 110 });

  // wait marker resumes to the next clock read
  const s3 = p.reducer(s2, waitMarker(110));
  assert.equal(s3.phase, "read_clock");

  // second cycle's job → runs:2 >= maxRuns:2 → done → finish
  const s4 = p.reducer(p.reducer(s3, clockResult(115)), jobResult(JOB));
  assert.equal(s4.runs, 2);
  assert.equal(s4.phase, "done");
  const a4 = p.step(s4);
  assert.equal(a4.type, "finish");
});

test("scheduleProgram: a failed job folds to { error } and STILL advances (no throw)", () => {
  const p = scheduleProgram({ intervalTicks: 5, maxRuns: 1, job: { effectKind: "tool_call", request: {} } });
  const s1 = p.reducer(p.initial, clockResult(50));
  const s2 = p.reducer(s1, jobFailure("boom"));
  assert.equal(s2.runs, 1);
  assert.equal(s2.phase, "done"); // maxRuns reached even on a failed job
  assert.deepEqual(s2.lastJob, { error: { message: "boom" } });
});

test("scheduleProgram: replay identity — folding a full 2-cycle journal twice yields the same state", () => {
  const p = scheduleProgram({ intervalTicks: 10, maxRuns: 2, job: { effectKind: "echo", request: JOB } });
  const records: JournalRecord[] = [
    clockResult(100, 1), jobResult({ echoed: 1 }, 2), waitMarker(110),
    clockResult(115, 4), jobResult({ echoed: 2 }, 5), finishMarker(),
  ];
  const a = replay(p.initial, records, p.reducer);
  const b = replay(p.initial, records, p.reducer);
  assert.deepEqual(a, b, "replay is deterministic");
  assert.deepEqual(a, { phase: "done", runs: 2, now: 115, nextAt: 125, lastJob: { echoed: 2 } });
});

test("scheduleProgram: construction validates intervalTicks / maxRuns / job (boundary guard)", () => {
  const job = { effectKind: "echo" as const, request: {} };
  assert.throws(() => scheduleProgram({ intervalTicks: 0, maxRuns: 1, job }), /intervalTicks must be a positive integer/);
  assert.throws(() => scheduleProgram({ intervalTicks: 1.5, maxRuns: 1, job }), /intervalTicks must be a positive integer/);
  assert.throws(() => scheduleProgram({ intervalTicks: 10, maxRuns: 0, job }), /maxRuns must be a positive integer/);
  assert.throws(
    () => scheduleProgram({ intervalTicks: 10, maxRuns: 1, job: null as unknown as typeof job }),
    /job must be/,
  );
});
