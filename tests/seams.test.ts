// Task 3: seam signatures + tactic-chain composition precedence.
// gateAction = most-restrictive-wins; decideNext = first-decisive-wins;
// assembleContext = ordered pipeline. Pure functions — no engine, no effects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeGate, composeDecideNext, composeAssemble } from "@irisrun/core";
import type {
  Tactic,
  ToolCall,
  ReadonlyHarnessView,
  DecideNext,
} from "@irisrun/core";

const call: ToolCall = { callId: "c1", name: "rm", args: {} };
const view: ReadonlyHarnessView = {
  phase: "decide_next",
  ctx: { messages: [] },
  modelOut: null,
  steps: 1,
  toolCalls: 0,
};

function gate(id: string, choice: "allow" | "deny" | "ask"): Tactic<"gateAction"> {
  return { id, seam: "gateAction", decide: () => choice };
}

test("composeGate is most-restrictive-wins (deny > ask > allow), order-independent", () => {
  assert.equal(composeGate([gate("a", "allow"), gate("b", "ask"), gate("c", "deny")], call), "deny");
  assert.equal(composeGate([gate("c", "deny"), gate("a", "allow")], call), "deny");
  assert.equal(composeGate([gate("a", "allow"), gate("b", "ask")], call), "ask");
  assert.equal(composeGate([gate("a", "allow")], call), "allow");
});

test("composeGate on an empty chain is the neutral 'allow' (kernel invariant adds the secure default)", () => {
  assert.equal(composeGate([], call), "allow");
});

function dn(id: string, out: DecideNext): Tactic<"decideNext"> {
  return { id, seam: "decideNext", decide: () => out };
}

test("composeDecideNext is first-decisive-wins ('continue' is not decisive)", () => {
  assert.equal(composeDecideNext([dn("a", "continue"), dn("b", "finish")], view), "finish");
  assert.deepEqual(
    composeDecideNext([dn("a", "continue"), dn("b", { wait: { kind: "user" } })], view),
    { wait: { kind: "user" } },
  );
  assert.equal(composeDecideNext([dn("a", "continue"), dn("b", "continue")], view), "continue");
  assert.equal(composeDecideNext([], view), "continue");
});

function asm(id: string, add: string): Tactic<"assembleContext"> {
  return {
    id,
    seam: "assembleContext",
    decide: ({ ctx }) => ({ messages: [...ctx.messages, { role: "system", content: add }] }),
  };
}

test("composeAssemble is a pipeline: each tactic transforms the accumulated context in order", () => {
  const out = composeAssemble([asm("a", "one"), asm("b", "two")], view);
  assert.deepEqual(out.messages, [
    { role: "system", content: "one" },
    { role: "system", content: "two" },
  ]);
});

test("composeAssemble on an empty chain yields the seed context", () => {
  assert.deepEqual(composeAssemble([], view), { messages: [] });
});
