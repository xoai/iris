// Proves the model-provider conformance suite has TEETH: a provider that returns the
// WRONG canonical result (and skips the no-model / no-key guards) must FAIL at least
// one case. Without this, a green suite could mean "the harness asserts nothing".
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Performer } from "@irisrun/core";
import { runModelProviderConformance } from "@irisrun/provider-conformance";
import type { ConformanceFixture } from "@irisrun/provider-conformance";

// A BROKEN provider: ignores the request, never enforces the guards, and always
// returns the wrong content / stopReason. Every real provider rule it violates.
const brokenPerf: Performer = (async () => ({
  ok: true,
  value: { role: "assistant", content: "WRONG", stopReason: "nope", usage: { inputTokens: 0, outputTokens: 0 } },
})) as unknown as Performer;

const brokenFixture: ConformanceFixture = {
  name: "broken",
  envKey: "BROKEN_API_KEY",
  makeBuffered: () => brokenPerf,
  makeStreaming: () => brokenPerf,
  bufferedResponseBody: () => ({}),
  streamingSseBody: () => "",
  fallbackResponseBody: () => ({}),
  malformedSseBody: () => "",
  expected: { content: "Hi there", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  expectedFallback: { content: "Hello", usage: { inputTokens: 3, outputTokens: 4 } },
  assertRequestShape: () => {},
  modelFromBody: (body) => body.model,
};

test("teeth: the suite FAILS a provider that returns the wrong canonical result", async () => {
  const cases = runModelProviderConformance(brokenFixture);
  let failures = 0;
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failures += 1;
    }
  }
  assert.ok(failures > 0, "a provider returning wrong content must fail at least one conformance case");
});
