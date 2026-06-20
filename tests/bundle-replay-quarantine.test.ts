// T8 — replay-incorruptibility of an INSTALLED external bundle (C4 extended).
// Mirrors tests/tactic-swap.test.ts exactly, but
// with @irisrun/bundle-coding's tacticPerformer as the session's installed tactic.
// Proof that an installed third-party (or malicious) bundle CANNOT corrupt a
// replayed session: (1) pure replay() with ZERO performers reconstructs the turn
// byte-identically; (2) resuming with an ADVERSARIAL performer (every seam choice
// flipped) leaves the result byte-identical AND the adversarial performer is NEVER
// invoked (advCalls===0). The replay quarantine — replay folds the journaled
// `choice` regardless of the authoring performer; `tacticId` is a label only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, decode, harnessProgram } from "@irisrun/core";
import type { EngineDeps, JournalRecord, HarnessState, Invariants, Performer, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { codingBundle } from "@irisrun/bundle-coding";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
// A read-only tool (allowed by the coding gate → no HITL park) then end_turn: a
// multi-decision turn (assemble → compact → model → gate → exec → decide_next ×2)
// so the journal carries SEVERAL seam decisions for replay to fold.
const MODEL: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "read_file", args: { path: "x" } }], stopReason: "tool_use" },
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

test("T8: an installed coding bundle's seam decisions are journaled; replay never re-invokes a tactic (adversarial swap → byte-identical, advCalls===0)", async () => {
  const store = new MemoryStateStore();
  const v1 = codingBundle(); // the INSTALLED external bundle
  const t1 = await runTurn(deps(store, v1.tacticPerformer, v1.invariants, { calls: [] }), "s");
  assert.equal(t1.status, "finished");
  const live = t1.status === "finished" ? t1.state : null;

  // (1) pure replay() — ZERO performers — reconstructs the multi-decision turn
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT, { invariants: v1.invariants });
  assert.equal(
    canonicalize(replay(program.initial, records, program.reducer)),
    canonicalize(live),
    "pure replay (zero performers) is byte-identical to the live turn",
  );

  // (2) resume the SAME session with an ADVERSARIAL performer — every seam choice
  // FLIPPED. Replay reads the journaled results, so the adversarial performer is
  // NEVER called and the state stays identical. This is the proof for an EXTERNAL
  // bundle: an installed/malicious tactic cannot corrupt a replayed session.
  let advCalls = 0;
  // The flipped choices WOULD change the output if invoked: deny the (allowed)
  // tool, finish before the model loop, blank the context — a strictly different
  // run, so a byte-identical result can only mean the adversary was not consulted.
  const flipped: Record<string, Json> = {
    gateAction: "deny", // would skip the read_file the live run executed
    decideNext: "finish", // would cut the loop short
    shouldCompact: { messages: [] }, // would blow away the context
    assembleContext: { messages: [] },
    onToolError: { action: "giveUp" },
  };
  const adversary: Performer = async (request) => {
    advCalls += 1;
    const seam = (request as { seam: string }).seam;
    return { ok: true, value: { seam, tacticId: "adversary", choice: flipped[seam] ?? null } };
  };
  const t2 = await runTurn(deps(store, adversary, v1.invariants, { calls: [] }), "s");
  assert.equal(t2.status, "finished");
  assert.equal(advCalls, 0, "the adversarial performer was NEVER invoked on replay (replay quarantine)");
  assert.equal(
    canonicalize(t2.status === "finished" ? t2.state : null),
    canonicalize(live),
    "replay is byte-identical despite the installed bundle's tactic being swapped for an adversary",
  );
});

test("T8: the adversarial choices are non-vacuous — a FRESH session run UNDER the adversary diverges from the coding-bundle run", async () => {
  // Quarantine-proof must be non-vacuous: prove the adversary WOULD change the
  // output if it were actually consulted. Run BOTH bundles fresh (no replay) and
  // assert their outputs differ — so the byte-identical resume above is meaningful.
  const codingStore = new MemoryStateStore();
  const v1 = codingBundle();
  const codingLog: ToolCallLog = { calls: [] };
  const coding = await runTurn(deps(codingStore, v1.tacticPerformer, v1.invariants, codingLog), "coding");
  assert.equal(coding.status, "finished");
  assert.equal(codingLog.calls.length, 1, "the coding bundle ran the allowed read_file");

  const advStore = new MemoryStateStore();
  let advCalls = 0;
  const flipped: Record<string, Json> = {
    gateAction: "deny",
    decideNext: "finish",
    shouldCompact: false,
    assembleContext: { messages: [] },
    onToolError: { action: "giveUp" },
  };
  const adversary: Performer = async (request) => {
    advCalls += 1;
    const seam = (request as { seam: string }).seam;
    return { ok: true, value: { seam, tacticId: "adversary", choice: flipped[seam] ?? null } };
  };
  const advLog: ToolCallLog = { calls: [] };
  const adv = await runTurn(deps(advStore, adversary, v1.invariants, advLog), "adv");
  assert.equal(adv.status, "finished");
  assert.ok(advCalls > 0, "the adversary IS consulted on a fresh (non-replay) run");
  assert.equal(advLog.calls.length, 0, "the adversary DENIED the tool — a strictly different run");

  // The two fresh runs diverge → the flipped choices are genuinely output-changing,
  // so the byte-identical adversarial RESUME in the test above is a real quarantine.
  assert.notEqual(
    canonicalize(coding.status === "finished" ? coding.state : null),
    canonicalize(adv.status === "finished" ? adv.state : null),
    "the coding-bundle run and the adversarial run produce DIFFERENT state (non-vacuous)",
  );
});
