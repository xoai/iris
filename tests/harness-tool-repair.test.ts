// Task 6 (M2) — C1 repair path: a tool failure routes to the onToolError seam.
// tool-repair does bounded retry, applies a tool-suggested fix (repair), or gives
// up. The kernel re-runs the call on retry/repair and advances on giveUp; the loop
// still finishes. All journaled; replay byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
  toolRepair,
} from "@iris/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  ToolCall,
  ErrorInfo,
  Performer,
  Json,
} from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "t", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function deps(store: MemoryStateStore, tool: Performer, repairAttempts = 2): EngineDeps<HarnessState> {
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
            return "allow";
          case "onToolError": {
            const pl = payload as { call: ToolCall; error: ErrorInfo; attempt: number };
            return toolRepair(repairAttempts).decide(pl);
          }
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
      tool_call: tool,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

async function assertReplayIdentical(store: MemoryStateStore, state: Json): Promise<void> {
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT);
  assert.equal(canonicalize(replay(program.initial, records, program.reducer)), canonicalize(state));
}

test("onToolError retry: a transient failure retries the same call and then succeeds", async () => {
  const store = new MemoryStateStore();
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(
    (_call, i) => (i === 0 ? { ok: false, error: { message: "transient" } } : { ok: true, value: { done: 1 } }),
    log,
  );
  const t = await runTurn(deps(store, tool), "s");
  assert.equal(t.status, "finished");
  assert.equal(log.calls.length, 2, "tool ran twice: fail then retry-success");
  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
});

test("onToolError repair: a tool-suggested fix patches the args and the retry succeeds", async () => {
  const store = new MemoryStateStore();
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool((call) => {
    const args = call.args as { repaired?: boolean };
    return args.repaired
      ? { ok: true, value: { done: 1 } }
      : { ok: false, error: { message: "bad schema", code: "E_SCHEMA", fix: { repaired: true } } };
  }, log);
  const t = await runTurn(deps(store, tool), "s");
  assert.equal(t.status, "finished");
  assert.equal(log.calls.length, 2);
  assert.deepEqual(log.calls[1].args, { repaired: true }, "retry used the repaired args");
  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
});

test("onToolError giveUp: an unrepairable failure gives up after the cap and advances; loop still finishes", async () => {
  const store = new MemoryStateStore();
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: false, error: { message: "always fails" } }), log);
  const t = await runTurn(deps(store, tool), "s");
  assert.equal(t.status, "finished", "loop finishes even after giving up on the tool");
  assert.equal(log.calls.length, 2, "tried maxAttempts (2) then gave up — no infinite loop");
  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
});

test("onToolError: a retry AFTER a repair keeps the repaired args (not the broken original)", async () => {
  const store = new MemoryStateStore();
  const log: ToolCallLog = { calls: [] };
  // i=0: original args → schema error WITH a suggested fix → repair patches {repaired:true}
  // i=1: repaired args but a transient failure → retry (must keep the repair patch)
  // i=2: repaired args → success
  const tool = makeFakeTool((call, i) => {
    const args = call.args as { repaired?: boolean };
    if (!args.repaired) return { ok: false, error: { message: "schema", code: "E_SCHEMA", fix: { repaired: true } } };
    if (i === 1) return { ok: false, error: { message: "transient" } };
    return { ok: true, value: { done: 1 } };
  }, log);
  const t = await runTurn(deps(store, tool, 3), "s"); // allow 3 attempts so the retry can run
  assert.equal(t.status, "finished");
  assert.equal(log.calls.length, 3);
  assert.deepEqual(log.calls[1].args, { repaired: true }, "the repaired call");
  assert.deepEqual(log.calls[2].args, { repaired: true }, "retry kept the repair patch (not the original)");
  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
});
