// @iris/evals — public surface (host; reproducible-eval arbiter, read-only scoring).
export const PACKAGE = "@iris/evals";

export { runEval, runSuite } from "./evals.ts";
export type { EvalCase, Scorer, EvalResult, SuiteResult } from "./evals.ts";
