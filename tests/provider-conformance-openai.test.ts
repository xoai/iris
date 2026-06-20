// OpenAI fixture for the shared model-provider conformance suite (done-when:
// two providers pass the SAME tests behind the model port). See the Anthropic twin
// in provider-conformance-anthropic.test.ts.
import assert from "node:assert/strict";
import { openaiModelPerformer, openaiStreamingModelPerformer } from "@irisrun/provider-openai";
import { runModelProviderConformance } from "./lib/model-provider-conformance.ts";
import type { ConformanceFixture } from "./lib/model-provider-conformance.ts";

function sse(...frames: unknown[]): string {
  return frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

const fixture: ConformanceFixture = {
  name: "openai",
  envKey: "OPENAI_API_KEY",
  makeBuffered: (opts) => openaiModelPerformer(opts),
  makeStreaming: (opts) => openaiStreamingModelPerformer(opts),
  bufferedResponseBody: () => ({
    choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }),
  streamingSseBody: () =>
    sse(
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
      { choices: [{ delta: { content: " there" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      "[DONE]",
    ),
  fallbackResponseBody: () => ({
    choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }),
  malformedSseBody: () =>
    `data: {not valid json\n\n` +
    sse({ choices: [{ delta: { content: "good" }, finish_reason: "stop" }] }, "[DONE]"),
  expected: { content: "Hi there", stopReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } },
  expectedFallback: { content: "Hello", usage: { inputTokens: 3, outputTokens: 4 } },
  assertRequestShape: (cap, sentApiKey) => {
    assert.match(cap.url, /\/v1\/chat\/completions$/);
    assert.equal(cap.headers.authorization, `Bearer ${sentApiKey}`);
    assert.equal(cap.headers["content-type"], "application/json");
    assert.equal(cap.body.model, "model-x");
    assert.equal(cap.body.max_tokens, 64);
    // system prompt becomes a leading "system" message (OpenAI has no top-level system)
    assert.deepEqual(cap.body.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  },
  modelFromBody: (body) => body.model,
};

runModelProviderConformance(fixture);
