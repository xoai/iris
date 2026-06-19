// M6 T6 — @iris/bundle-coding, the first domain bundle. A HOST-SIDE package that
// composes coding-specialized tactics on the 5 seams from core's EXPORTED
// primitives (core stays byte-untouched). It produces the SAME journaled
// `{seam, tacticId, choice}` shape as defaultBundle, so the ADR-0007 quarantine
// applies to it unchanged. This test proves: (1) the performer answers all 5
// seams with `tacticId:"iris/coding"`; (2) the gate ALLOWS a read-only tool but
// gates a write/shell tool to "ask"; (3) a full turn runs under the bundle (via
// core runTurn + scripted model/tool performers) and finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, harnessProgram } from "@iris/core";
import type { EngineDeps, HarnessState, Json, Invariants, Performer } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { codingBundle, BUNDLE_ID, PACKAGE } from "@iris/bundle-coding";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "edit the file" }] };

async function perform(seam: string, payload: Json): Promise<Json> {
  const { tacticPerformer } = codingBundle();
  const out = await tacticPerformer({ seam, payload });
  assert.equal(out.ok, true, `seam '${seam}' must succeed`);
  return out.ok ? out.value : null;
}

test("T6: codingBundle exposes its package + id", () => {
  assert.equal(PACKAGE, "@iris/bundle-coding");
  assert.equal(BUNDLE_ID, "iris/coding");
});

test("T6: the performer returns {seam, tacticId:'iris/coding', choice} for all 5 seams", async () => {
  const cases: Array<{ seam: string; payload: Json }> = [
    {
      seam: "assembleContext",
      payload: {
        state: { phase: "assemble", ctx: null, modelOut: null, steps: 0, toolCalls: 0 },
        ctx: { messages: [{ role: "user", content: "hi" }] },
      },
    },
    { seam: "shouldCompact", payload: { ctx: { messages: [], tokens: 0 }, budget: {} } },
    {
      seam: "decideNext",
      payload: { state: { phase: "decide_next", ctx: null, modelOut: { stopReason: "end_turn" }, steps: 1, toolCalls: 0 } },
    },
    { seam: "gateAction", payload: { call: { callId: "a", name: "read_file", args: {} } } },
    {
      seam: "onToolError",
      payload: { call: { callId: "a", name: "read_file", args: {} }, error: { message: "x" }, attempt: 0 },
    },
  ];
  for (const { seam, payload } of cases) {
    const value = (await perform(seam, payload)) as { seam: string; tacticId: string; choice: Json };
    assert.equal(value.seam, seam, `result seam echoes the request seam`);
    assert.equal(value.tacticId, "iris/coding", `tacticId is the bundle label`);
    assert.ok("choice" in value, `result carries a choice for '${seam}'`);
  }
});

test("T6: gate ALLOWS a read-only tool but gates a write/shell tool to 'ask'", async () => {
  const allow = (await perform("gateAction", { call: { callId: "1", name: "read_file", args: {} } })) as {
    choice: Json;
  };
  assert.equal(allow.choice, "allow", "read_file (read-only) is allowed");

  const search = (await perform("gateAction", { call: { callId: "2", name: "search", args: {} } })) as {
    choice: Json;
  };
  assert.equal(search.choice, "allow", "search (read-only) is allowed");

  const list = (await perform("gateAction", { call: { callId: "3", name: "list", args: {} } })) as {
    choice: Json;
  };
  assert.equal(list.choice, "allow", "list (read-only) is allowed");

  const write = (await perform("gateAction", { call: { callId: "4", name: "write_file", args: {} } })) as {
    choice: Json;
  };
  assert.equal(write.choice, "ask", "write_file (write) is gated to ask");

  const shell = (await perform("gateAction", { call: { callId: "5", name: "run_shell", args: {} } })) as {
    choice: Json;
  };
  assert.equal(shell.choice, "ask", "run_shell (shell) is gated to ask");
});

test("T6: an unknown seam fails loudly (no silent fold)", async () => {
  const { tacticPerformer } = codingBundle();
  const out = await tacticPerformer({ seam: "spawnPolicy", payload: null });
  assert.equal(out.ok, false, "unknown seam → loud {ok:false}");
});

function deps(store: MemoryStateStore, tactic: Performer, invariants: Invariants, log: ToolCallLog): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants }),
    performers: {
      tactic,
      model_call: makeScriptedModel([
        { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "read_file", args: { path: "x" } }], stopReason: "tool_use" },
        { role: "assistant", content: "done", stopReason: "end_turn" },
      ]),
      tool_call: makeFakeTool(() => ({ ok: true, value: { contents: "..." } }), log),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("T6: a full turn runs under codingBundle and finishes (read-only tool allowed, no HITL park)", async () => {
  const store = new MemoryStateStore();
  const bundle = codingBundle();
  const log: ToolCallLog = { calls: [] };
  const t = await runTurn(deps(store, bundle.tacticPerformer, bundle.invariants, log), "s");
  assert.equal(t.status, "finished", "the coding turn finishes (read_file is allowed, so no park)");
  assert.equal(log.calls.length, 1, "the read-only tool ran exactly once");
  assert.equal(log.calls[0].name, "read_file");
});
