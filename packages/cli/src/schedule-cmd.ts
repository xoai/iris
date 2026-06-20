// `iris schedule` command logic (roadmap P2-9) — the testable unit. Makes a recurring,
// durably-replayable job reachable from the CLI: build a scheduleProgram, run its first
// cycle, then drive the host-side pump (makeScheduleRunner) forward in logical time,
// resuming each due cycle. cli-main.ts wires the real sqlite host + the default echo job;
// the logic lives here so it is unit-tested with an injected host + scheduler.
//
// Honest scope: scheduleProgram runs ONE effect per cycle (a `clock` read + the job
// effect + a durable timer park), NOT a full agent turn — a recurring single-effect job
// (e.g. echo, a tool_call, or a subagent spawn). Determinism comes from the journaled
// clock results; given the same config + performers the whole schedule replays identically.
import { runTurnOn } from "@irisrun/host";
import type { HostAdapter } from "@irisrun/host";
import { scheduleProgram, makeScheduleRunner } from "@irisrun/schedule";
import type { ScheduleJob, WakeupSource } from "@irisrun/schedule";
import type { PerformerRegistry, TurnOutcome, Json } from "@irisrun/core";

export interface CmdScheduleOptions {
  host: HostAdapter; // the store + scheduler the schedule session lives on
  source: WakeupSource; // the scheduler's peek/confirm surface (sqlite/memory both implement it)
  sessionId: string;
  intervalTicks: number; // logical-time units between cycles (> 0)
  maxRuns: number; // finish after this many job runs (> 0)
  ticks: number; // pump steps to drive after the start cycle (≥ 0)
  job: ScheduleJob; // { effectKind, request } — one effect per cycle
  // Performers for ONE cycle bound to `now` — MUST include a `clock` performer and a
  // performer for `job.effectKind`. (cli-main binds clock→now and the job effect.)
  cyclePerformers: (now: number) => PerformerRegistry;
  defDigest?: string;
}

export interface CmdScheduleResult {
  cycles: { now: number; status: TurnOutcome<Json>["status"] }[];
  text: string;
}

export async function cmdSchedule(opts: CmdScheduleOptions): Promise<CmdScheduleResult> {
  if (!Number.isInteger(opts.ticks) || opts.ticks < 0) {
    throw new Error(`iris schedule: --ticks must be a non-negative integer, got ${String(opts.ticks)}`);
  }
  // scheduleProgram validates intervalTicks/maxRuns LOUDLY (> 0 integers) — build it
  // ONCE up front so a bad config fails before any turn runs.
  const program = scheduleProgram({ intervalTicks: opts.intervalTicks, maxRuns: opts.maxRuns, job: opts.job });
  const defDigest = opts.defDigest ?? "iris-schedule";

  const inputsAt = (now: number): { defDigest: string; program: typeof program; performers: PerformerRegistry; clock: { now: () => number } } => ({
    defDigest,
    program,
    performers: opts.cyclePerformers(now),
    clock: { now: () => now },
  });

  const runner = makeScheduleRunner({
    host: opts.host,
    source: opts.source,
    resumeInputs: (_sessionId, now) => inputsAt(now),
  });

  const cycles: CmdScheduleResult["cycles"] = [];
  // Cycle 1 runs at t=0 (parks on a durable timer at intervalTicks).
  const start = await runTurnOn(opts.host, { sessionId: opts.sessionId, ...inputsAt(0) });
  cycles.push({ now: 0, status: start.status });

  // Advance logical time; the pump resumes each due cycle and confirms after it commits.
  for (let k = 1; k <= opts.ticks; k++) {
    const now = k * opts.intervalTicks;
    const tick = await runner.tick(now);
    for (const fired of tick.fired) cycles.push({ now, status: fired.status });
  }

  const text = cycles.map((c) => JSON.stringify(c)).join("\n");
  return { cycles, text };
}
