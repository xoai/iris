// P2-8 M3 — reproduce(): an explicit, provable reproducibility check for evals.
// Runs an EvalCase N independent times and proves byte-identical {score, status,
// full-journal digest} across runs. A deterministic case → reproducible:true; a case
// with an in-process leak (model content that drifts per build()) → reproducible:false
// with the first divergence located. Builds on the EvalCase pattern in evals.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { reproduce, type EvalCase, type Scorer } from "@irisrun/evals";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

const scorer: Scorer<HarnessState> = (inspection, outcome) => ({
  terminal: inspection.terminal,
  status: outcome.status,
  effects: inspection.counts.effects,
  results: inspection.counts.results,
});

// A deterministic, finishing case (rm safe → tool runs → finishes in one turn).
function deterministicCase(): EvalCase<HarnessState> {
  const bundle = defaultBundle({ safeTools: ["rm"] });
  return {
    name: "deterministic",
    turns: 1,
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

// A LEAKY case: model content drifts per build() via mutable shared state. Each run's
// journal differs → reproducible:false. (The leak survives the fresh-build contract
// because the counter lives OUTSIDE build().)
function leakyCase(): EvalCase<HarnessState> {
  const bundle = defaultBundle({ safeTools: ["rm"] });
  let drift = 0;
  return {
    name: "leaky",
    turns: 1,
    build() {
      const tag = drift++; // DIFFERENT each independent run → non-reproducible journal
      const deps: EngineDeps<HarnessState> = {
        store: new MemoryStateStore(),
        scheduler: new MemoryScheduler(),
        clock: new TestClock(1),
        program: harnessProgram(INPUT, { invariants: bundle.invariants }),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: makeScriptedModel([{ role: "assistant", content: `done ${tag}`, stopReason: "end_turn" }]),
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

test("reproduce: a deterministic case is reproducible across 3 runs", async () => {
  const r = await reproduce(deterministicCase(), scorer, { runs: 3 });
  assert.equal(r.reproducible, true, `expected reproducible, divergence: ${JSON.stringify(r.divergence)}`);
  assert.equal(r.runs, 3);
  assert.equal(r.divergence, undefined);
  assert.equal((r.result.score as { terminal: string }).terminal, "finished");
  assert.match(r.journalDigest, /^[0-9a-f]{8}$/, "journalDigest is a short hex fingerprint");
});

test("reproduce: a content-drifting (leaky) case is NOT reproducible, divergence located", async () => {
  const r = await reproduce(leakyCase(), scorer, { runs: 3 });
  assert.equal(r.reproducible, false);
  assert.ok(r.divergence, "a divergence is reported");
  assert.equal(r.divergence!.field, "journal", "structure/score match; only the journal bytes drift");
  assert.equal(r.divergence!.run, 1, "the divergence is caught on the second run");
});

test("reproduce: runs < 2 is coerced to 2 (reproducibility needs ≥2 runs)", async () => {
  const r = await reproduce(deterministicCase(), scorer, { runs: 1 });
  assert.equal(r.runs, 2);
  assert.equal(r.reproducible, true);
});

test("reproduce: journalDigest is stable across independent reproduce() calls of a deterministic case", async () => {
  const a = await reproduce(deterministicCase(), scorer);
  const b = await reproduce(deterministicCase(), scorer);
  assert.equal(a.journalDigest, b.journalDigest, "same deterministic case → same journal digest");
});
