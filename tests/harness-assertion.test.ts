// Task 11 (M2) — C6: the always-on replay-consistency assertion stays green across
// default-bundle turns. With assertReplay ON the engine re-runs replay and asserts
// byte-equality after EVERY committed step, throwing ReplayDivergenceError on any
// divergence — so a turn that finishes/parks is itself the proof the harness never
// broke determinism (the ADR-0007 guarantee).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, harnessProgram, defaultBundle } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";

function bundleDeps(
  store: MemoryStateStore,
  input: { messages: { role: string; content: string }[] },
  budget: { tokens?: number },
  model: Json[],
  safeTools: string[] = ["search"],
): EngineDeps<HarnessState> {
  const bundle = defaultBundle({ safeTools });
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(input, { invariants: bundle.invariants, budget }),
    performers: {
      tactic: bundle.tacticPerformer,
      model_call: makeScriptedModel(model),
      tool_call: makeFakeTool(() => ({ ok: true, value: { ok: 1 } })),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true, // C6: assert after every committed step
  };
}

const TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "search", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

test("C6: replay-consistency assertion holds across a default-bundle tool-loop turn", async () => {
  const store = new MemoryStateStore();
  const t = await runTurn(bundleDeps(store, { messages: [{ role: "user", content: "go" }] }, {}, TOOL_THEN_DONE), "s");
  assert.equal(t.status, "finished"); // finishing under assertReplay ON == no divergence
});

test("C6: replay-consistency assertion holds across a default-bundle compaction turn", async () => {
  const store = new MemoryStateStore();
  const longInput = {
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ],
  };
  const t = await runTurn(
    bundleDeps(store, longInput, { tokens: 2 }, [{ role: "assistant", content: "done", stopReason: "end_turn" }]),
    "s",
  );
  assert.equal(t.status, "finished");
});

test("C6: replay-consistency assertion holds across a default-bundle HITL park", async () => {
  const store = new MemoryStateStore();
  // safeTools=[] → the tool is gated to "ask" → the turn parks. Reaching the park
  // under assertReplay ON means the assertion held at every step up to the park.
  const t = await runTurn(
    bundleDeps(store, { messages: [{ role: "user", content: "go" }] }, {}, TOOL_THEN_DONE, []),
    "s",
  );
  assert.equal(t.status, "parked");
});
