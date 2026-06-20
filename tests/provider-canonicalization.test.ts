// Provider canonicalization under DIVERGENT "compatible" responses —
// the provider-compat-matrix foundation. The recorded model_call
// effect must replay byte-identically, so every adapter must canonicalize the
// shapes that "OpenAI-compatible" / Anthropic-compatible endpoints quietly differ
// on — missing finish_reason/stop_reason, missing usage, empty content/choices,
// unknown extra fields, and streams that omit the terminator — to the SAME stable
// ModelCallResult {role, content, stopReason, usage?}. No live keys: crafted
// bodies via injected fetch / SSE. (Per-provider because the two SSE/JSON shapes
// and termination models genuinely differ.)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import { anthropicModelPerformer, anthropicStreamingModelPerformer } from "@irisrun/provider-anthropic";
import { openaiModelPerformer, openaiStreamingModelPerformer } from "@irisrun/provider-openai";

interface Result {
  role: string;
  content: string;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const REQ: Json = { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 32 };

function bufferedFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}
function sseFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}
async function run(perf: ReturnType<typeof anthropicModelPerformer>): Promise<Result> {
  const out = await perf(REQ);
  assert.ok(out.ok, "canonicalization call must succeed (no throw on a divergent-but-valid body)");
  return out.value as unknown as Result;
}

// ── Anthropic buffered divergences ───────────────────────────────────────────

test("canon/anthropic: missing stop_reason → default 'end_turn'", async () => {
  const r = await run(anthropicModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ role: "assistant", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 1, output_tokens: 2 } }),
  }));
  assert.equal(r.content, "Hi");
  assert.equal(r.stopReason, "end_turn");
});

test("canon/anthropic: missing usage → result has no usage (no throw)", async () => {
  const r = await run(anthropicModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ role: "assistant", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" }),
  }));
  assert.equal(r.usage, undefined);
});

test("canon/anthropic: empty content blocks → content '' (graceful)", async () => {
  const r = await run(anthropicModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ role: "assistant", content: [], stop_reason: "end_turn" }),
  }));
  assert.equal(r.content, "");
});

test("canon/anthropic: unknown extra fields are ignored (forward-compat)", async () => {
  const r = await run(anthropicModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({
      id: "msg_x", model: "claude-z", type: "message", futField: { nested: true },
      role: "assistant", content: [{ type: "text", text: "Hi", extra: 1 }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 9 },
    }),
  }));
  assert.equal(r.content, "Hi");
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2 });
});

// ── OpenAI buffered divergences ──────────────────────────────────────────────

test("canon/openai: missing finish_reason → default 'stop'", async () => {
  const r = await run(openaiModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
  }));
  assert.equal(r.content, "Hi");
  assert.equal(r.stopReason, "stop");
});

test("canon/openai: missing usage → result has no usage (no throw)", async () => {
  const r = await run(openaiModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }),
  }));
  assert.equal(r.usage, undefined);
});

test("canon/openai: empty choices → content '' (graceful)", async () => {
  const r = await run(openaiModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({ choices: [] }),
  }));
  assert.equal(r.content, "");
});

test("canon/openai: unknown extra fields are ignored (forward-compat)", async () => {
  const r = await run(openaiModelPerformer({
    apiKey: "k",
    fetchImpl: bufferedFetch({
      id: "chatcmpl-x", object: "chat.completion", system_fingerprint: "fp_x", service_tier: "default",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi", refusal: null }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  }));
  assert.equal(r.content, "Hi");
  assert.equal(r.stopReason, "stop");
  assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2 });
});

// ── Streaming divergences (per-provider termination model) ───────────────────

test("canon/openai stream: NO [DONE] sentinel still resolves; content === join(deltas)", async () => {
  const deltas: string[] = [];
  // a compatible endpoint that simply ends the stream without `data: [DONE]`
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: " there" }, finish_reason: "stop" }] })}\n\n`;
  const perf = openaiStreamingModelPerformer({ apiKey: "k", fetchImpl: sseFetch(body), onDelta: (t) => deltas.push(t) });
  const out = await perf(REQ);
  assert.ok(out.ok);
  const r = out.value as unknown as Result;
  assert.equal(r.content, "Hi there");
  assert.equal(r.content, deltas.join(""), "reconcile invariant: content equals the concatenated deltas");
  assert.equal(r.stopReason, "stop");
});

test("canon/anthropic stream: NO message_stop still resolves on reader-done; content === join(deltas)", async () => {
  const deltas: string[] = [];
  // a stream that ends after the deltas without an explicit message_stop event
  // (the reader routes on the data JSON's own `type`, not the decorative event: line)
  const body =
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })}\n\n` +
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: " there" } })}\n\n`;
  const perf = anthropicStreamingModelPerformer({ apiKey: "k", fetchImpl: sseFetch(body), onDelta: (t) => deltas.push(t) });
  const out = await perf(REQ);
  assert.ok(out.ok);
  const r = out.value as unknown as Result;
  assert.equal(r.content, "Hi there");
  assert.equal(r.content, deltas.join(""), "reconcile invariant: content equals the concatenated deltas");
});

test("canon/both stream: a malformed data frame is skipped, not thrown", async () => {
  // OpenAI: a junk frame between two good ones
  const oaDeltas: string[] = [];
  const oaBody =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n` +
    `data: {not json at all\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: "stop" }] })}\n\n`;
  const oa = await openaiStreamingModelPerformer({ apiKey: "k", fetchImpl: sseFetch(oaBody), onDelta: (t) => oaDeltas.push(t) })(REQ);
  assert.ok(oa.ok);
  assert.equal((oa.value as unknown as Result).content, "AB");

  // Anthropic: a junk frame between two good ones
  const anDeltas: string[] = [];
  const anBody =
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "A" } })}\n\n` +
    `data: {broken\n\n` +
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "B" } })}\n\n`;
  const an = await anthropicStreamingModelPerformer({ apiKey: "k", fetchImpl: sseFetch(anBody), onDelta: (t) => anDeltas.push(t) })(REQ);
  assert.ok(an.ok);
  assert.equal((an.value as unknown as Result).content, "AB");
});
