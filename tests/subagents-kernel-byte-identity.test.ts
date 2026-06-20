// P2-9 (C1 / A-6) — the load-bearing byte-identity guard for the gated `subagentTools`
// kernel branch. The harness kernel is golden-pinned and edited concurrently across many
// worktrees, so the subagent flag MUST be zero-value-off: with the set absent/empty — or
// non-empty but NOT containing the emitted tool's name — the committed journal must be
// byte-for-byte identical to today's `tool_call` path. This test pins exactly that.
//
// It is RED-first against the UNMODIFIED kernel only in the trivial sense that it proves
// the harness is deterministic (three identical runs ⇒ identical bytes); after T1.2 wires
// the branch it ALSO proves the branch is inert unless a name matches (variants 2 & 3) and
// that a MATCHING name flips the effect to `subagent` (the positive test below).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  encode,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@irisrun/core";
import type {
  EngineDeps,
  HarnessState,
  HarnessConfig,
  JournalRecord,
  ReadonlyHarnessView,
  ModelContext,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };

// One ordinary tool call, then finish — drives assemble→model→gate(allow)→tool_exec→
// decide_next(continue)→assemble→model(done)→decide_next(finish)→done in ONE turn (no park).
function script(toolName: string): Json[] {
  return [
    { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: toolName, args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ];
}

// A deterministic tactic router: real react tactics, no compaction, gate ALLOW (so the
// tool/subagent runs without a HITL park — keeps the turn single-shot).
function tacticPerformer() {
  return makeTacticRouter((seam, payload) => {
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
  });
}

// Drive a non-interactive tool turn to completion, returning the committed journal as an
// array of base64-encoded record bytes (the canonical on-disk form the durability contract
// pins). `subagentResult` is registered as the `subagent` performer so a name match has a
// performer to call.
async function recordBytes(
  toolName: string,
  config: HarnessConfig,
): Promise<{ status: string; bytes: string[]; kinds: string[] }> {
  const store = new MemoryStateStore();
  const records: JournalRecord[] = [];
  const deps: EngineDeps<HarnessState> = {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, config),
    performers: {
      tactic: tacticPerformer(),
      model_call: makeScriptedModel(script(toolName)),
      tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
      // a trivial subagent performer so a name match has somewhere to land (only used by
      // the positive routing test; inert when no name matches).
      subagent: async () => ({ ok: true, value: { sessionId: "child", status: "finished", output: { ok: true } } }),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    onRecord: (r) => records.push(r),
  };
  const out = await runTurn(deps, "s");
  return {
    status: out.status,
    bytes: records.map((r) => Buffer.from(encode(r as unknown as Json)).toString("base64")),
    kinds: records
      .filter((r) => r.kind === "effect_intent")
      .map((r) => (r.payload as { effectKind: string }).effectKind),
  };
}

test("A-6: subagentTools absent / empty / non-matching → byte-identical journal", async () => {
  const baseline = await recordBytes("mytool", {});
  const emptySet = await recordBytes("mytool", { subagentTools: [] });
  const nonMatching = await recordBytes("mytool", { subagentTools: ["some-other-tool"] });

  assert.equal(baseline.status, "finished", "the tool turn finishes in one runTurn");
  assert.ok(baseline.bytes.length > 0, "records were captured");
  // The emitted tool is an ordinary `tool_call` in all three (the gate is inert).
  assert.ok(baseline.kinds.includes("tool_call"), "baseline emits a tool_call effect");
  assert.deepEqual(emptySet.bytes, baseline.bytes, "subagentTools:[] is byte-identical to no config");
  assert.deepEqual(nonMatching.bytes, baseline.bytes, "a non-matching subagentTools name is byte-identical");
});

test("C1 positive: a MATCHING subagentTools name routes tool_exec to a `subagent` effect", async () => {
  // The emitted tool is named "delegate" AND listed in subagentTools → the tool_exec step
  // must emit a `subagent` effect instead of `tool_call`.
  const matched = await recordBytes("delegate", { subagentTools: ["delegate"] });
  assert.equal(matched.status, "finished", "the delegating turn still finishes");
  assert.ok(matched.kinds.includes("subagent"), "a subagent effect was emitted at tool_exec");
  assert.ok(!matched.kinds.includes("tool_call"), "no tool_call effect for the delegated name");
});
