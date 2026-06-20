// Task 11 (M2) — C4 HEADLINE: every seam decision is journaled, and replay NEVER
// re-invokes a tactic. Proof: run a default-bundle turn live (recording the seam
// decisions), then (1) pure replay() with ZERO performers reconstructs the
// multi-decision turn byte-identically, and (2) resuming with a DIFFERENT tactic
// performer whose every decision differs leaves the result byte-identical and the
// swapped-in tactic is never called — the ADR-0007 quarantine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, decode, harnessProgram, defaultBundle } from "@irisrun/core";
import type { EngineDeps, JournalRecord, HarnessState, Invariants, Performer, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const MODEL: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "search", args: { q: "x" } }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function deps(store: MemoryStateStore, tactic: Performer, invariants: Invariants, log: ToolCallLog): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants }),
    performers: {
      tactic,
      model_call: makeScriptedModel(MODEL),
      tool_call: makeFakeTool(() => ({ ok: true, value: { ok: 1 } }), log),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C4: seam decisions are journaled; replay reads them and never re-invokes a tactic (swap → byte-identical)", async () => {
  const store = new MemoryStateStore();
  const v1 = defaultBundle({ safeTools: ["search"] });
  const t1 = await runTurn(deps(store, v1.tacticPerformer, v1.invariants, { calls: [] }), "s");
  assert.equal(t1.status, "finished");
  const live = t1.status === "finished" ? t1.state : null;

  // (1) pure replay() — ZERO performers — reconstructs the multi-decision turn
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT, { invariants: v1.invariants });
  assert.equal(canonicalize(replay(program.initial, records, program.reducer)), canonicalize(live));

  // (2) resume with a DIFFERENT tactic performer (v2) — every decision differs.
  // Replay reads the journaled results, so v2 is NEVER called and the state is identical.
  let v2Calls = 0;
  const wrong: Record<string, Json> = {
    gateAction: "deny",
    decideNext: "finish",
    shouldCompact: false,
    assembleContext: { messages: [] },
    onToolError: { action: "giveUp" },
  };
  const v2: Performer = async (request) => {
    v2Calls += 1;
    const seam = (request as { seam: string }).seam;
    return { ok: true, value: { seam, tacticId: "v2", choice: wrong[seam] ?? null } };
  };
  const t2 = await runTurn(deps(store, v2, v1.invariants, { calls: [] }), "s");
  assert.equal(t2.status, "finished");
  assert.equal(v2Calls, 0, "the swapped-in tactic was NEVER invoked on replay (ADR-0007 quarantine)");
  assert.equal(
    canonicalize(t2.status === "finished" ? t2.state : null),
    canonicalize(live),
    "replay is byte-identical despite the tactic code being swapped",
  );
});
