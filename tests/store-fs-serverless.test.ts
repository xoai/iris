// T2 (M-Proof) — the SERVERLESS cold-per-turn invariant. A turn is driven with a
// FRESH FsStateStore instance; it parks on the HITL signal wait. A SEPARATE,
// brand-new FsStateStore over the SAME root resumes and finishes. No method holds
// a long-lived handle, so a cold invocation (new instance) behaves identically to
// a warm one — the serverless model (rehydrate → one runTurn → persist).
//
// Scheduler: a MemoryScheduler is injected (FsScheduler is Task 3). waitForSignal
// is a no-op for the HITL park and the resume is signal_recv-performer-driven, so
// the scheduler is off T2's critical path. The model/tool/signal performers are
// the "external services" — created ONCE and reused across turns; only the STORE
// goes cold (the thing the serverless invariant is about).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, harnessProgram, defaultBundle } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json, Performer } from "@irisrun/core";
import { MemoryScheduler } from "@irisrun/store-memory";
import { FsStateStore } from "@irisrun/store-fs";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

// A turn over a COLD store instance. The store is built fresh per call (the
// serverless invariant); the performers are passed in (they persist, like an
// external model/tool/HITL service does).
function coldTurn(
  root: string,
  bundle: ReturnType<typeof defaultBundle>,
  model: Performer,
  tool: Performer,
  signal: Performer,
): EngineDeps<HarnessState> {
  return {
    store: new FsStateStore({ root }), // FRESH instance every turn — no warm handle
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants: bundle.invariants }),
    performers: {
      tactic: bundle.tacticPerformer,
      model_call: model,
      tool_call: tool,
      signal_recv: signal,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("T2: a cold FsStateStore parks on the HITL wait; a SEPARATE cold instance over the same root resumes + finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "iris-fs-serverless-"));
  const bundle = defaultBundle({ safeTools: [] }); // nothing safe → 'rm' gated to ask
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const signal = makeFakeSignal(true);

  // Turn 1 — cold instance #1. The irreversible tool is gated to ask → park.
  // assertReplay:true is on; parking must not throw ReplayDivergenceError.
  const t1 = await runTurn(coldTurn(root, bundle, model, tool, signal), "s");
  assert.equal(t1.status, "parked");
  assert.deepEqual(t1.status === "parked" ? t1.wait : null, { kind: "signal", name: "hitl:a" });
  assert.equal(log.calls.length, 0, "the gated tool does not run while parked");

  // Turn 2 — a BRAND-NEW instance over the SAME root (cold start; no shared
  // memory). It must rehydrate from disk, read the approval, run the tool, finish.
  const t2 = await runTurn(coldTurn(root, bundle, model, tool, signal), "s");
  assert.equal(t2.status, "finished");
  assert.equal(log.calls.length, 1, "the approved tool runs exactly once on the cold resume");
});
