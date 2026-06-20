// P2-9 (A-5) — composition: a SCHEDULE whose per-tick job is a `subagent` spawn. This wires
// both features together: the schedule program parks/wakes on durable timers (driven by the
// pump), and each cycle's job is a delegation performed by the subagent performer. Every
// delegation is journaled in the schedule's journal, the child agent runs on the durable
// substrate, and the whole thing replays identically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnOn } from "@irisrun/host";
import type { HostAdapter } from "@irisrun/host";
import { harnessProgram, defaultBundle, replay } from "@irisrun/core";
import type { PerformerRegistry, Json, LogicalClock, StateStore, EffectIntent } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeScheduleRunner, scheduleProgram, type ResumeInputs } from "@irisrun/schedule";
import type { ScheduleState } from "@irisrun/schedule";
import { makeSubagentPerformer, type ResolvedChild } from "@irisrun/subagents";
import { makeScriptedModel, type CallCounter } from "./lib/fake-model.ts";

const INTERVAL = 10;
const SID = "sched-deleg";
const CHILD_REPLY: Json = { role: "assistant", content: "child-tick", stopReason: "end_turn" };

function childResolver(childStore: StateStore, childCounter: CallCounter, childScheduler: MemoryScheduler) {
  return (): ResolvedChild => ({
    host: { name: "child-host", capabilities: { long_running: true }, store: childStore, scheduler: childScheduler },
    defDigest: "child-def",
    program: harnessProgram({ messages: [{ role: "user", content: "do-tick" }] }),
    performers: { tactic: defaultBundle().tacticPerformer, model_call: makeScriptedModel([CHILD_REPLY], childCounter) },
    clock: { now: () => 1 },
  });
}

function scheduleInputs(now: number, maxRuns: number, subagentPerf: PerformerRegistry["subagent"]) {
  const clock: LogicalClock = { now: () => now };
  return {
    defDigest: "sched-def",
    program: scheduleProgram({
      intervalTicks: INTERVAL,
      maxRuns,
      // the job IS a delegation: a `subagent` effect whose request is a delegating ToolCall.
      job: { effectKind: "subagent" as const, request: { callId: "job", name: "delegate", args: { unit: "work" } } },
    }),
    performers: {
      clock: async () => ({ ok: true, value: clock.now() }),
      subagent: subagentPerf,
    } as PerformerRegistry,
    clock,
  };
}

test("A-5: a schedule whose job is a subagent spawn delegates each cycle, durably & replayably", async () => {
  const maxRuns = 2;
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const host: HostAdapter = { name: "sched-host", capabilities: { long_running: true }, store, scheduler };

  const childStore = new MemoryStateStore();
  const childScheduler = new MemoryScheduler();
  const childCounter: CallCounter = { n: 0 };
  const subagentPerf = makeSubagentPerformer({
    parentSessionId: SID,
    resolveChild: childResolver(childStore, childCounter, childScheduler),
  });

  const resumeInputs: ResumeInputs = (_sid, now) => scheduleInputs(now, maxRuns, subagentPerf);
  const runner = makeScheduleRunner({ host, source: scheduler, resumeInputs });

  // Cycle 1 @0: delegate to the child (spawns it), park @10.
  const start = await runTurnOn(host, { sessionId: SID, ...scheduleInputs(0, maxRuns, subagentPerf) });
  assert.equal(start.status, "parked");
  // Cycle 2 @10: delegate again (re-enters the same durable child → replay), finish at maxRuns.
  const t10 = await runner.tick(10);
  assert.deepEqual(t10.fired, [{ sessionId: SID, status: "finished" }]);

  // The child agent ran on the durable substrate (its own journal exists).
  const childRows = await childStore.readJournal("sched-deleg::sub::job", 0);
  assert.ok(childRows.length > 0, "the child agent has its own durable journal");
  assert.equal(childCounter.n, 1, "the child model ran ONCE; the re-delegation replayed it (durability)");

  // Each cycle journaled a `subagent` delegation (maxRuns of them).
  const rows = await store.readJournal(SID, 0);
  const records = rows.map((r) => JSON.parse(Buffer.from(r.bytes).toString("utf8")) as Json);
  const subagentIntents = records.filter(
    (r) => (r as { kind?: string }).kind === "effect_intent" &&
      ((r as { payload?: EffectIntent }).payload?.effectKind === "subagent"),
  );
  assert.equal(subagentIntents.length, maxRuns, "one delegation journaled per cycle");

  // The full schedule replays identically and carries the child's output as its last job.
  const prog = scheduleProgram({ intervalTicks: INTERVAL, maxRuns, job: { effectKind: "subagent", request: { callId: "job", name: "delegate", args: { unit: "work" } } } });
  const a = replay(prog.initial, records as never[], prog.reducer) as ScheduleState;
  const b = replay(prog.initial, records as never[], prog.reducer) as ScheduleState;
  assert.deepEqual(a, b, "the composed schedule replays deterministically");
  assert.equal(a.runs, maxRuns);
  assert.equal(a.phase, "done");
  assert.equal((a.lastJob as { status?: string }).status, "finished", "last delegation finished");
});
