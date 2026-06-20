// Runnable demo (install-free): proves both features on the durable substrate.
//   node --conditions=iris-src packages/schedule/src/demo.ts
// Prints one JSON line per event. No network, no key, no external deps — a scripted model.
//
// (1) DELEGATION: a parent agent with a `delegate` subagent-tool delegates to a child agent;
//     the child's reply rides back as the parent's tool result. Both are durable sessions.
// (2) SCHEDULE: a recurring job parks on durable timers between runs; a host-side pump
//     advances logical time, resumes each due cycle, and confirms after the turn commits.
import { runTurn, harnessProgram, defaultBundle } from "@irisrun/core";
import { runTurnOn, type HostAdapter } from "@irisrun/host";
import type { Json, Performer, PerformerRegistry, LogicalClock } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeSubagentPerformer, type ResolvedChild } from "@irisrun/subagents";
import { makeScheduleRunner, scheduleProgram } from "@irisrun/schedule";

function emit(event: string, data: Json): void {
  process.stdout.write(`${JSON.stringify({ event, ...(data as object) })}\n`);
}

// A scripted model: returns the i-th response (clamped). Install-free, deterministic.
function scriptedModel(responses: Json[]): Performer {
  let i = 0;
  return async () => ({ ok: true, value: responses[Math.min(i++, responses.length - 1)] });
}

async function delegationDemo(): Promise<void> {
  const parentStore = new MemoryStateStore();
  const childStore = new MemoryStateStore();

  const resolveChild = (): ResolvedChild => ({
    host: { name: "child", capabilities: { long_running: true }, store: childStore, scheduler: new MemoryScheduler() },
    defDigest: "child-def",
    program: harnessProgram({ messages: [{ role: "user", content: "sub-task" }] }),
    performers: {
      tactic: defaultBundle().tacticPerformer,
      model_call: scriptedModel([{ role: "assistant", content: "I did the sub-task.", stopReason: "end_turn" }]),
    },
    clock: { now: () => 1 },
  });
  const subagent = makeSubagentPerformer({ parentSessionId: "parent", resolveChild });

  const out = await runTurn(
    {
      store: parentStore,
      scheduler: new MemoryScheduler(),
      clock: { now: () => 1 },
      // `delegate` is registered as a subagent-tool AND as a safe tool (auto-allowed gate).
      program: harnessProgram({ messages: [{ role: "user", content: "delegate this" }] }, { subagentTools: ["delegate"] }),
      performers: {
        tactic: defaultBundle({ safeTools: ["delegate"] }).tacticPerformer,
        model_call: scriptedModel([
          { role: "assistant", content: "delegating", toolCalls: [{ callId: "x1", name: "delegate", args: { task: "sub" } }], stopReason: "tool_use" },
          { role: "assistant", content: "the child handled it", stopReason: "end_turn" },
        ]),
        subagent,
      },
      defDigest: "parent-def",
      holderId: "demo",
    },
    "parent",
  );
  emit("delegation", { status: out.status, childSessionId: "parent::sub::x1" });
}

async function scheduleDemo(): Promise<void> {
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const host: HostAdapter = { name: "sched", capabilities: { long_running: true }, store, scheduler };
  const maxRuns = 3;
  const interval = 10;

  const inputsAt = (now: number): { defDigest: string; program: ReturnType<typeof scheduleProgram>; performers: PerformerRegistry; clock: LogicalClock } => {
    const clock: LogicalClock = { now: () => now };
    return {
      defDigest: "sched-def",
      program: scheduleProgram({ intervalTicks: interval, maxRuns, job: { effectKind: "echo", request: { ping: true } } }),
      performers: { clock: async () => ({ ok: true, value: clock.now() }), echo: async (r: Json) => ({ ok: true, value: r }) },
      clock,
    };
  };

  const runner = makeScheduleRunner({ host, source: scheduler, resumeInputs: (_s, now) => inputsAt(now) });

  // Start (cycle 1 @ t=0), then tick logical time forward; the pump resumes each due cycle.
  const start = await runTurnOn(host, { sessionId: "job-1", ...inputsAt(0) });
  emit("schedule", { cycle: 1, now: 0, status: start.status });
  for (const now of [10, 20]) {
    const r = await runner.tick(now);
    for (const f of r.fired) emit("schedule", { now, status: f.status });
  }
}

async function main(): Promise<void> {
  await delegationDemo();
  await scheduleDemo();
}

main().catch((err: unknown) => {
  process.stderr.write(`[schedule-demo] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
