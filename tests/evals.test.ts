// T3 (M5) — the reproducible-eval arbiter (spec 03 §7: reproducibility, not taste).
// runEval calls case.build() on EVERY invocation → a fresh store AND fresh
// performers (the scripted-model/-tool closure index resets to 0); within one run
// deps.performers persist across the `turns`. It runs EXACTLY `turns` runTurn calls
// (never loop-until-finished — a parking case must not hang) and scores the last
// outcome via inspectSession. Same case+scorer re-run → byte-identical score; a
// swapped tactic → a different-but-reproducible score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle, canonicalize } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { runEval, runSuite, type EvalCase, type Scorer } from "@irisrun/evals";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

// An eval case = a deterministic scenario. The bundle (pure) is captured once; the
// STATEFUL bits (store + scripted performers) are created FRESH inside build() so
// each runEval invocation resets the scripted index to 0.
function hitlCase(name: string, safeTools: string[], turns: number): EvalCase<HarnessState> {
  const bundle = defaultBundle({ safeTools });
  return {
    name,
    turns,
    build() {
      const deps: EngineDeps<HarnessState> = {
        store: new MemoryStateStore(),
        scheduler: new MemoryScheduler(),
        clock: new TestClock(1),
        program: harnessProgram(INPUT, { invariants: bundle.invariants }),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
          tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
          signal_recv: makeFakeSignal(true),
        },
        defDigest: "d",
        holderId: "H",
        assertReplay: true,
      };
      return { deps, sessionId: "s" };
    },
  };
}

const scorer: Scorer<HarnessState> = (inspection, outcome) => ({
  terminal: inspection.terminal,
  status: outcome.status,
  effects: inspection.counts.effects,
  results: inspection.counts.results,
});

test("T3: runEval is reproducible — the same case+scorer re-run yields a byte-identical score", async () => {
  const finishing = hitlCase("finish", ["rm"], 1); // rm is safe → tool runs → finishes in one turn
  const r1 = await runEval(finishing, scorer);
  const r2 = await runEval(finishing, scorer);
  assert.equal((r1.score as { terminal: string }).terminal, "finished");
  assert.equal(
    canonicalize(r1.score),
    canonicalize(r2.score),
    "a fresh build() each run (scripted index from 0) → byte-identical score",
  );
});

test("T3: a PARKING case scores reproducibly WITHOUT hanging (exactly `turns` runs)", async () => {
  const parking = hitlCase("park", [], 1); // rm gated → parks in one turn; turns:1 → no resume, no hang
  const r1 = await runEval(parking, scorer);
  const r2 = await runEval(parking, scorer);
  assert.equal((r1.score as { terminal: string }).terminal, "parked");
  assert.equal(r1.status, "parked");
  assert.equal(canonicalize(r1.score), canonicalize(r2.score));
});

test("T3: a SWAPPED tactic yields a different — but itself reproducible — score", async () => {
  const finishing = hitlCase("finish", ["rm"], 1); // rm safe → finished
  const parking = hitlCase("park", [], 1); // rm gated → parked
  const f = await runEval(finishing, scorer);
  const p = await runEval(parking, scorer);
  assert.notEqual(
    canonicalize(f.score),
    canonicalize(p.score),
    "swapping the gate tactic (safe vs gated) changes the recorded session → a different score",
  );
});

test("T3: runSuite aggregates ≥2 cases", async () => {
  const suite = await runSuite([hitlCase("finish", ["rm"], 1), hitlCase("park", [], 1)], scorer);
  assert.equal(suite.results.length, 2);
  assert.deepEqual(suite.results.map((r) => r.name).sort(), ["finish", "park"]);
  assert.equal((suite.results.find((r) => r.name === "finish")!.score as { terminal: string }).terminal, "finished");
  assert.equal((suite.results.find((r) => r.name === "park")!.score as { terminal: string }).terminal, "parked");
});
