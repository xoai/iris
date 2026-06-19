// Task 8 (M2) — C3: HITL. gateAction "ask" parks the turn on a hitl:<callId>
// signal; on resume the kernel reads the approval as a signal_recv EFFECT (folded
// into state), then runs or skips the tool. The approval is journaled, so replay
// is deterministic and never re-reads a live signal; recovery re-performs the
// signal_recv once and the idempotent fixture cannot flip approve↔deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  acquireLease,
  encode,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@iris/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  GateChoice,
  Performer,
  Json,
  Version,
} from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { makeFakeSignal, type CallCounter } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

// Performers are created ONCE per test and reused across turns (a model/tool/HITL
// service persists across a park/resume — only the journaled state is durable).
function deps(
  store: MemoryStateStore,
  gate: GateChoice,
  model: Performer,
  tool: Performer,
  signal: Performer,
): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact":
            return false;
          case "gateAction":
            return gate;
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: model,
      tool_call: tool,
      signal_recv: signal,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C3 approve: gateAction 'ask' parks on the hitl signal; resume with approval runs the tool", async () => {
  const store = new MemoryStateStore();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const signal = makeFakeSignal(true);

  const t1 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t1.status, "parked");
  assert.deepEqual(t1.status === "parked" ? t1.wait : null, { kind: "signal", name: "hitl:a" });
  assert.equal(log.calls.length, 0, "tool is not run while parked for approval");

  const t2 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t2.status, "finished");
  assert.equal(log.calls.length, 1, "the approved tool runs on resume");
});

test("C3 deny: resume with denial skips the tool; the loop still finishes", async () => {
  const store = new MemoryStateStore();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const signal = makeFakeSignal(false);

  const t1 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t1.status, "parked");
  const t2 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t2.status, "finished");
  assert.equal(log.calls.length, 0, "the denied tool never runs");
});

test("C3 recovery: a dangling signal_recv intent re-performs once; approval does not flip", async () => {
  const store = new MemoryStateStore();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const sigCounter: CallCounter = { n: 0 };
  const signal = makeFakeSignal(true, sigCounter);

  const t1 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t1.status, "parked");

  // simulate a crash AFTER the signal_recv intent was written but before its result
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  const rows = await store.readJournal("s", 0);
  const intentSeq = rows[rows.length - 1].seq + 1;
  const intent: JournalRecord = {
    seq: intentSeq,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: {
      effectId: `signal_recv:${intentSeq}`,
      effectKind: "signal_recv",
      request: { name: "hitl:a" },
      retrySafe: false,
    },
  };
  const appended = await store.append("s", intentSeq, [encode(intent as unknown as Json)], fence);
  assert.ok(appended.ok, "setup append failed");

  const t2 = await runTurn(deps(store, "ask", model, tool, signal), "s");
  assert.equal(t2.status, "finished");
  assert.equal(sigCounter.n, 1, "signal_recv re-performed exactly once on recovery");
  assert.equal(log.calls.length, 1, "the approved tool runs after recovery (approval did not flip)");
});
