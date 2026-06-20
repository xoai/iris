// Anthropic fixture for the shared model-provider conformance suite. The EXISTING
// @irisrun/provider-anthropic performers run the exact same behavioral tests as
// @irisrun/provider-openai — that parity IS the P1-6 "done when". (anthropic-adapter
// / anthropic-streaming tests remain as provider-specific detail coverage.)
import assert from "node:assert/strict";
import { anthropicModelPerformer, anthropicStreamingModelPerformer } from "@irisrun/provider-anthropic";
import { runModelProviderConformance } from "./lib/model-provider-conformance.ts";
import type { ConformanceFixture } from "./lib/model-provider-conformance.ts";

function sse(...frames: unknown[]): string {
  return frames.map((f) => `event: e\ndata: ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

const fixture: ConformanceFixture = {
  name: "anthropic",
  envKey: "ANTHROPIC_API_KEY",
  makeBuffered: (opts) => anthropicModelPerformer(opts),
  makeStreaming: (opts) => anthropicStreamingModelPerformer(opts),
  bufferedResponseBody: () => ({
    role: "assistant",
    content: [
      { type: "text", text: "Hi" },
      { type: "text", text: " there" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  }),
  streamingSseBody: () =>
    sse(
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " there" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ),
  fallbackResponseBody: () => ({
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
  }),
  malformedSseBody: () =>
    `event: e\ndata: {not valid json\n\n` +
    sse(
      { type: "content_block_delta", delta: { type: "text_delta", text: "good" } },
      { type: "message_stop" },
    ),
  expected: { content: "Hi there", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  expectedFallback: { content: "Hello", usage: { inputTokens: 3, outputTokens: 4 } },
  assertRequestShape: (cap, sentApiKey) => {
    assert.match(cap.url, /\/v1\/messages$/);
    assert.equal(cap.headers["x-api-key"], sentApiKey);
    assert.ok(cap.headers["anthropic-version"], "sends an anthropic-version header");
    assert.equal(cap.body.model, "model-x");
    assert.equal(cap.body.system, "be brief"); // Anthropic uses a top-level system field
    assert.equal(cap.body.max_tokens, 64);
    assert.deepEqual(cap.body.messages, [{ role: "user", content: "hi" }]);
  },
  modelFromBody: (body) => body.model,
};

runModelProviderConformance(fixture);
