// Task 10: defaultBundle() wires react + window-compaction + tool-repair +
// approve-irreversible into ONE pure tactic performer (seam → composed chain) plus
// the kernel invariant caps. The runner injects that performer as `tactic`. A
// safe-tool loop runs to finish; an irreversible (unknown) tool defaults to ask
// (the gate-irreversible floor) and parks.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  harnessProgram,
  defaultBundle,
} from "@irisrun/core";
import type { EngineDeps, JournalRecord, HarnessState, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog, type ToolScript } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };

function modelWithTool(name: string): Json[] {
  return [
    { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name, args: { q: "x" } }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ];
}

const OK_TOOL: ToolScript = () => ({ ok: true, value: { ok: 1 } });

function deps(
  store: MemoryStateStore,
  bundle: ReturnType<typeof defaultBundle>,
  model: Json[],
  log: ToolCallLog,
  toolScript: ToolScript = OK_TOOL,
): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants: bundle.invariants }),
    performers: {
      tactic: bundle.tacticPerformer,
      model_call: makeScriptedModel(model),
      tool_call: makeFakeTool(toolScript, log),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("default bundle: a safe-tool loop runs to finish, fully journaled and replay-identical", async () => {
  const store = new MemoryStateStore();
  const bundle = defaultBundle({ safeTools: ["search"] });
  const log: ToolCallLog = { calls: [] };

  const t = await runTurn(deps(store, bundle, modelWithTool("search"), log), "s");
  assert.equal(t.status, "finished");
  assert.deepEqual(t.status === "finished" ? t.output : null, {
    reply: { role: "assistant", content: "done", stopReason: "end_turn" },
  });
  assert.deepEqual(log.calls.map((c) => c.name), ["search"], "the safe tool was allowed and ran");

  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT, { invariants: bundle.invariants });
  assert.equal(
    canonicalize(replay(program.initial, records, program.reducer)),
    canonicalize(t.status === "finished" ? t.state : program.initial),
  );
});

test("default bundle: an irreversible (unknown) tool defaults to ask and parks (gate-irreversible floor)", async () => {
  const store = new MemoryStateStore();
  const bundle = defaultBundle({ safeTools: [] }); // nothing is safe
  const log: ToolCallLog = { calls: [] };

  const t = await runTurn(deps(store, bundle, modelWithTool("rm"), log), "s");
  assert.equal(t.status, "parked", "an unlisted tool is gated to ask → parks for approval");
  assert.deepEqual(t.status === "parked" ? t.wait : null, { kind: "signal", name: "hitl:a" });
  assert.equal(log.calls.length, 0, "the irreversible tool did not run");
});

test("default bundle: a failing tool is repaired by the bundle's tool-repair end-to-end (retry → success)", async () => {
  const store = new MemoryStateStore();
  const bundle = defaultBundle({ safeTools: ["search"] });
  const log: ToolCallLog = { calls: [] };

  // exercises bundle.ts's onToolError case (the composed tool-repair tactic),
  // not just the router fixture: fail once, then the bundle retries to success.
  const t = await runTurn(
    deps(store, bundle, modelWithTool("search"), log, (_call, i) =>
      i === 0 ? { ok: false, error: { message: "transient" } } : { ok: true, value: { ok: 1 } },
    ),
    "s",
  );
  assert.equal(t.status, "finished");
  assert.equal(log.calls.length, 2, "the bundle's onToolError retried the failed call through to success");
});
