// C2 — `iris eval`: the testable command logic + the suite loader.
// Proves (1) the dynamic-import-of-a-user-`.mjs`-suite path works under the repo's
// `--conditions=iris-src` ESM setup (the loader is new surface — this is its proof,
// so the fixture is a REAL on-disk .mjs imported by file:// URL, never in-memory);
// (2) runSuite text/json rendering; (3) --reproduce rendering incl. a deliberately
// non-reproducible case → divergence located; (4) a malformed suite (missing/wrong
// export) fails LOUDLY before any case runs. cli-main.ts's evalCommand (real argv →
// pathToFileURL IO) is not unit-tested per repo convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cmdEval, loadEvalSuite } from "iris-runtime";

// Fixtures MUST live UNDER the repo so the .mjs's bare `@irisrun/*` imports resolve via
// the workspace node_modules symlinks + the iris-src condition (a /tmp fixture would
// not find node_modules). We write into a unique dir beside this test file.
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const FIX_ROOT = join(TESTS_DIR, ".eval-fixtures");
mkdirSync(FIX_ROOT, { recursive: true });

function writeFixture(body: string): string {
  const dir = mkdtempSync(join(FIX_ROOT, "s-"));
  const file = join(dir, "suite.mjs");
  writeFileSync(file, body);
  return pathToFileURL(file).href;
}

// A real harness eval suite: a one-turn agent that a scripted model finishes. The
// `flaky` case advances a MODULE-LEVEL counter NOT reset by build(), so each
// reproduce run records a different model reply → a non-reproducible journal.
const SUITE_BODY = `
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

function scriptedModel(responses) {
  let i = 0;
  return async () => ({ ok: true, value: responses[Math.min(i++, responses.length - 1)] });
}
function buildCase(content) {
  return {
    deps: {
      store: new MemoryStateStore(),
      scheduler: new MemoryScheduler(),
      clock: { now: () => 0 },
      program: harnessProgram({ messages: [{ role: "user", content: "hi" }] }),
      performers: {
        tactic: defaultBundle().tacticPerformer,
        model_call: scriptedModel([{ role: "assistant", content, stopReason: "end_turn" }]),
      },
      defDigest: "eval-def",
      holderId: "eval",
    },
    sessionId: "s",
  };
}
let flakyN = 0;
export const cases = [
  { name: "greets", build: () => buildCase("hello") },
  { name: "flaky", build: () => buildCase("r" + (flakyN++)) },
];
export const scorer = (_inspection, outcome) => ({ finished: outcome.status === "finished" });
`;

test("loadEvalSuite: imports a real on-disk .mjs and returns {cases, scorer}", async () => {
  const url = writeFixture(SUITE_BODY);
  const suite = await loadEvalSuite(url);
  assert.ok(Array.isArray(suite.cases) && suite.cases.length === 2);
  assert.equal(typeof suite.scorer, "function");
  assert.equal(suite.cases[0].name, "greets");
});

test("cmdEval runSuite: renders `<name>: <score> (<status>)` per case", async () => {
  const suite = await loadEvalSuite(writeFixture(SUITE_BODY));
  const { results, text } = await cmdEval(suite);
  assert.ok(results && results.length === 2);
  assert.equal(results[0].status, "finished");
  assert.match(text, /greets: \{"finished":true\} \(finished\)/);
  assert.match(text, /flaky: \{"finished":true\} \(finished\)/);
});

test("cmdEval --json: returns the structured results", async () => {
  const suite = await loadEvalSuite(writeFixture(SUITE_BODY));
  const { results } = await cmdEval(suite, { json: true });
  assert.ok(results);
  assert.deepEqual(results.map((r) => r.name), ["greets", "flaky"]);
});

test("cmdEval --reproduce: a stable case is reproducible; a flaky case locates divergence", async () => {
  const suite = await loadEvalSuite(writeFixture(SUITE_BODY));
  const { reports, text } = await cmdEval(suite, { reproduce: 3 });
  assert.ok(reports && reports.length === 2);
  const greets = reports.find((r) => r.name === "greets");
  const flaky = reports.find((r) => r.name === "flaky");
  assert.ok(greets, "greets report present");
  assert.ok(flaky, "flaky report present");
  assert.equal(greets.reproducible, true);
  assert.equal(flaky.reproducible, false);
  assert.ok(flaky.divergence, "the flaky case must locate a divergence");
  assert.match(text, /greets: reproducible=true/);
  assert.match(text, /flaky: reproducible=false/);
  assert.match(text, /divergence@\d+:(score|status|journal)/);
});

test("loadEvalSuite: a module missing `cases` fails LOUDLY (before any case runs)", async () => {
  const url = writeFixture(`export const scorer = () => ({});\n`); // no `cases`
  await assert.rejects(() => loadEvalSuite(url), /cases/);
});

test("loadEvalSuite: a module whose `scorer` is not a function fails LOUDLY", async () => {
  const url = writeFixture(`export const cases = []; export const scorer = 42;\n`);
  await assert.rejects(() => loadEvalSuite(url), /scorer/);
});

test.after(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
});
