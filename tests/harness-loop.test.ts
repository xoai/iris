// Task 5 (M2) — C1: a multi-step ReAct tool loop runs to finish, every effect
// journaled, replay byte-identical. The scripted model returns tool calls on the
// first turn and end_turn on the second; the react tactic loops while the model
// wants tools and finishes when it stops. gateAction allows; tools are simulated
// in-process (real protocol-boundary tools are M3).
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
} from "@iris/core";
import type {
  EngineDeps,
  JournalRecord,
  EffectIntent,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Json,
} from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel, type CallCounter } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const MODEL_RESPONSES: Json[] = [
  {
    role: "assistant",
    content: "use tools",
    toolCalls: [
      { callId: "a", name: "search", args: { q: "x" } },
      { callId: "b", name: "fetch", args: {} },
    ],
    stopReason: "tool_use",
  },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function deps(
  store: MemoryStateStore,
  modelCounter: CallCounter,
  toolLog: ToolCallLog,
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
            return "allow";
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(MODEL_RESPONSES, modelCounter),
      tool_call: makeFakeTool((call) => ({ ok: true, value: { tool: call.name, ran: true } }), toolLog),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C1: multi-step tool loop runs to finish; model+tool+tactic effects journaled; replay identical", async () => {
  const store = new MemoryStateStore();
  const mc: CallCounter = { n: 0 };
  const toolLog: ToolCallLog = { calls: [] };

  const t1 = await runTurn(deps(store, mc, toolLog), "s");
  assert.equal(t1.status, "finished");
  assert.deepEqual(t1.status === "finished" ? t1.output : null, {
    reply: { role: "assistant", content: "done", stopReason: "end_turn" },
  });
  assert.equal(mc.n, 2, "model called twice (tool turn, then final)");
  assert.deepEqual(
    toolLog.calls.map((c) => c.name),
    ["search", "fetch"],
    "both tools executed once, in order",
  );

  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const intentsOf = (k: string) =>
    records.filter(
      (r) => r.kind === "effect_intent" && (r.payload as EffectIntent).effectKind === k,
    ).length;
  assert.equal(intentsOf("model_call"), 2, "two model_call effects journaled");
  assert.equal(intentsOf("tool_call"), 2, "two tool_call effects journaled");
  assert.equal(
    intentsOf("tactic"),
    8,
    "exactly 8 seam consultations: 2×(assembleContext + shouldCompact + decideNext) + 2×gateAction",
  );

  // C6: replay reconstructs live state with no performer
  const program = harnessProgram(INPUT);
  const replayed = replay(program.initial, records, program.reducer);
  assert.equal(
    canonicalize(replayed),
    canonicalize(t1.status === "finished" ? t1.state : program.initial),
  );

  // resume → nothing re-invoked
  const t2 = await runTurn(deps(store, mc, toolLog), "s");
  assert.equal(t2.status, "finished");
  assert.equal(mc.n, 2, "resume must not re-call the model");
  assert.equal(toolLog.calls.length, 2, "resume must not re-run tools");
});
