// `iris eval` command logic (roadmap P2-8) — the testable unit. Makes reproducible
// evals REACHABLE from the CLI: load a user eval-suite module, run it (or prove it
// reproducible), and render. cli-main.ts wires the real argv → file:// import; the
// logic lives here so it is unit-tested with an in-test suite module.
//
// A suite is CODE, not data: `EvalCase.build()` returns live `EngineDeps` (a fresh
// store + performers per call). So the CLI can only consume a suite MODULE — the
// loadBundledTools precedent (a project ships a small JS module the CLI imports). The
// module must export `cases: EvalCase[]` and `scorer: Scorer`; both are validated
// LOUDLY before any case runs (no silent empty suite).
import { runSuite, reproduce } from "@irisrun/evals";
import type { EvalCase, Scorer, EvalResult, ReproReport } from "@irisrun/evals";
import type { Json } from "@irisrun/core";

export interface EvalSuite {
  cases: EvalCase<Json>[];
  scorer: Scorer<Json>;
}

export interface CmdEvalOptions {
  reproduce?: number; // run each case N≥2 times and prove byte-identical (else runSuite once)
  json?: boolean; // return structured results only (cli-main prints them)
}

export interface CmdEvalResult {
  results?: EvalResult[]; // present unless --reproduce
  reports?: ReproReport[]; // present with --reproduce
  text: string; // the human-readable render (cli-main prints this unless --json)
}

// Dynamically import an eval-suite module and validate its public surface. `moduleUrl`
// MUST be a resolvable URL (cli-main passes pathToFileURL(absPath).href). A module
// that lacks `cases` (array) or `scorer` (function) throws with a clear, file-naming
// message — a misconfigured suite is an operator error, not an empty run.
export async function loadEvalSuite(moduleUrl: string): Promise<EvalSuite> {
  const mod = (await import(moduleUrl)) as { cases?: unknown; scorer?: unknown };
  if (!Array.isArray(mod.cases)) {
    throw new Error(
      `iris eval: suite module '${moduleUrl}' must export \`cases\` (an array of EvalCase); got ${typeof mod.cases}`,
    );
  }
  if (typeof mod.scorer !== "function") {
    throw new Error(
      `iris eval: suite module '${moduleUrl}' must export \`scorer\` (a function); got ${typeof mod.scorer}`,
    );
  }
  return { cases: mod.cases as EvalCase<Json>[], scorer: mod.scorer as Scorer<Json> };
}

function renderResult(r: EvalResult): string {
  return `${r.name}: ${JSON.stringify(r.score)} (${r.status})`;
}

function renderReport(r: ReproReport): string {
  const div = r.divergence ? ` divergence@${r.divergence.run}:${r.divergence.field}` : "";
  return `${r.name}: reproducible=${r.reproducible} digest=${r.journalDigest} runs=${r.runs}${div}`;
}

export async function cmdEval(suite: EvalSuite, opts: CmdEvalOptions = {}): Promise<CmdEvalResult> {
  if (opts.reproduce !== undefined) {
    const runs = opts.reproduce;
    if (!Number.isInteger(runs) || runs < 2) {
      throw new Error(`iris eval --reproduce: runs must be an integer ≥ 2, got ${String(runs)}`);
    }
    const reports: ReproReport[] = [];
    for (const c of suite.cases) reports.push(await reproduce(c, suite.scorer, { runs }));
    return { reports, text: reports.map(renderReport).join("\n") };
  }
  const { results } = await runSuite(suite.cases, suite.scorer);
  return { results, text: results.map(renderResult).join("\n") };
}
