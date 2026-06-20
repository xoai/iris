// The reproducible-eval arbiter (spec 03 §7): "reproducible evals are the arbiter,
// not editorial taste." An EvalCase is a DETERMINISTIC scenario; a Scorer reads the
// recorded session (via @irisrun/inspect) and the last turn outcome. runEval calls
// case.build() on EVERY invocation, so it gets a FRESH store AND fresh performers
// (the scripted-model/-tool closure index resets to 0); within a single run the
// built performers PERSIST across the `turns` (a park→resume advances the index).
// It runs EXACTLY `turns` (default 1) sequential runTurn calls — NEVER
// loop-until-finished (a perpetually-parking case must not hang) — and scores the
// LAST outcome. Same case+scorer → byte-identical score; swapped tactic → different.
// Runner is core runTurn (no host needed). READ-ONLY scoring.
import { runTurn } from "@irisrun/core";
import type { EngineDeps, Json, TurnOutcome } from "@irisrun/core";
import { inspectSession, type SessionInspection } from "@irisrun/inspect";

export interface EvalCase<S extends Json> {
  name: string;
  // Build a fresh, deterministic scenario. MUST allocate a fresh store and fresh
  // performers on every call so reproducibility re-runs start from index 0.
  build(): { deps: EngineDeps<S>; sessionId: string };
  turns?: number; // sequential runTurn calls to drive (default 1); NOT loop-until-finished
}

export type Scorer<S extends Json> = (inspection: SessionInspection, outcome: TurnOutcome<S>) => Json;

export interface EvalResult {
  name: string;
  score: Json;
  status: TurnOutcome<Json>["status"] | "open";
}

export interface SuiteResult {
  results: EvalResult[];
}

/** Run one eval case to score. Deterministic and reproducible across invocations. */
export async function runEval<S extends Json>(c: EvalCase<S>, scorer: Scorer<S>): Promise<EvalResult> {
  const { deps, sessionId } = c.build(); // FRESH store + performers (index resets to 0)
  const turns = c.turns ?? 1;
  let outcome: TurnOutcome<S> | null = null;
  for (let i = 0; i < turns; i++) {
    // reuse `deps` across turns → performers persist (park→resume advances state)
    outcome = await runTurn(deps, sessionId);
  }
  const inspection = await inspectSession(deps.store, sessionId);
  const status = outcome ? outcome.status : "open";
  const score = outcome ? scorer(inspection, outcome) : null;
  return { name: c.name, score, status };
}

/** Run a suite of cases under one scorer; aggregate the reproducible results. */
export async function runSuite<S extends Json>(cases: EvalCase<S>[], scorer: Scorer<S>): Promise<SuiteResult> {
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runEval(c, scorer));
  return { results };
}
