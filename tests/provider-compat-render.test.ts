// Drift guard (roadmap v0.2 §9, plan T9.6) — the agentfile/docs-funnel drift-guard
// pattern applied to the compatibility matrix. The table embedded in
// docs/06-providers.md between the COMPAT-MATRIX markers MUST equal
// renderCompatMatrix() byte-for-byte, so the published matrix can NEVER silently
// diverge from the registry (a rotted matrix is a false promise — roadmap §7 risk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderCompatMatrix } from "@irisrun/provider-compat";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

test("render: deterministic (two calls byte-identical)", () => {
  assert.equal(renderCompatMatrix(), renderCompatMatrix());
});

test("render: grouped by protocol with both section headings", () => {
  const out = renderCompatMatrix();
  assert.ok(out.includes("### OpenAI Chat Completions protocol"), "OpenAI section heading");
  assert.ok(out.includes("### Anthropic Messages protocol"), "Anthropic section heading");
  // OpenAI section precedes the Anthropic section (stable protocol order)
  assert.ok(
    out.indexOf("### OpenAI") < out.indexOf("### Anthropic Messages"),
    "OpenAI-protocol section comes first",
  );
});

test("render: every endpoint label + replaySafety appears in the output", () => {
  const out = renderCompatMatrix();
  for (const label of ["Groq", "Azure OpenAI", "AWS Bedrock (Claude)", "Anthropic"]) {
    assert.ok(out.includes(label), `render is missing ${label}`);
  }
  assert.ok(out.includes("replay-safe"), "render shows replay-safe entries");
  assert.ok(out.includes("known-divergent"), "render shows known-divergent entries");
});

test("render: DRIFT GUARD — docs/06-providers.md table equals renderCompatMatrix()", () => {
  const doc = readFileSync(join(DOCS, "06-providers.md"), "utf8");
  const m = doc.match(/<!-- COMPAT-MATRIX:START[^>]*-->\n([\s\S]*?)\n<!-- COMPAT-MATRIX:END -->/);
  assert.ok(m, "docs/06-providers.md must contain the COMPAT-MATRIX:START/END markers");
  const embedded = m![1];
  assert.equal(
    embedded,
    renderCompatMatrix(),
    "docs/06-providers.md compatibility table has drifted from @irisrun/provider-compat — " +
      "regenerate it (the table is generated, do not hand-edit).",
  );
});
