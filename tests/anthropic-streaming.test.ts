// serve-streaming Task 3 (AS-2): the streaming model performer parses Anthropic
// SSE via an INJECTED fetch (no network/key), fires onDelta per text delta in
// order, and returns the SAME ModelCallResult the buffered path would — so the
// journaled effect_result reconciles with join(deltas). Plus: content-type
// fallback, malformed-frame tolerance, and a loud failure on a missing model id.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import { anthropicStreamingModelPerformer } from "@irisrun/provider-anthropic";
import type { ModelCallResult } from "@irisrun/provider-anthropic";

function sseEvents(...objs: Json[]): string {
  return objs.map((o) => `event: e\ndata: ${JSON.stringify(o)}`).join("\n\n") + "\n\n";
}
function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

test("streaming performer: parses SSE, onDelta in order, content === join(deltas)", async () => {
  const body = sseEvents(
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: " there" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  );
  const deltas: string[] = [];
  const perf = anthropicStreamingModelPerformer({
    apiKey: "sk-test",
    fetchImpl: fetchReturning(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    onDelta: (t) => deltas.push(t),
  });
  const out = await perf({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  if (out.ok) {
    const r = out.value as unknown as ModelCallResult;
    assert.deepEqual(deltas, ["Hi", " there"]);
    assert.equal(r.content, "Hi there");
    assert.equal(deltas.join(""), r.content, "reconcile invariant: content == join(deltas)");
    assert.equal(r.stopReason, "end_turn");
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 2 });
  }
});

test("streaming performer: opts.model is used when the request carries no model (harness has none)", async () => {
  let sentModel: unknown = null;
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    sentModel = JSON.parse(init.body).model;
    return new Response(
      sseEvents({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }, { type: "message_stop" }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  const perf = anthropicStreamingModelPerformer({ apiKey: "k", fetchImpl: fakeFetch, model: "claude-from-lock" });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json); // NO model in request
  assert.ok(out.ok);
  assert.equal(sentModel, "claude-from-lock");
});

test("streaming performer: content-type not SSE → fallback buffers + fires ONE delta", async () => {
  const buffered = JSON.stringify({
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  const deltas: string[] = [];
  const perf = anthropicStreamingModelPerformer({
    apiKey: "k",
    fetchImpl: fetchReturning(new Response(buffered, { headers: { "content-type": "application/json" } })),
    onDelta: (t) => deltas.push(t),
  });
  const out = await perf({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  if (out.ok) {
    const r = out.value as unknown as ModelCallResult;
    assert.equal(r.content, "Hello");
    assert.deepEqual(deltas, ["Hello"], "exactly one delta with the whole text");
    assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 4 });
  }
});

test("streaming performer: a malformed data frame is SKIPPED, not thrown", async () => {
  const body =
    `event: e\ndata: {this is not json\n\n` +
    sseEvents(
      { type: "content_block_delta", delta: { type: "text_delta", text: "good" } },
      { type: "message_stop" },
    );
  const perf = anthropicStreamingModelPerformer({
    apiKey: "k",
    fetchImpl: fetchReturning(new Response(body, { headers: { "content-type": "text/event-stream" } })),
  });
  const out = await perf({ model: "claude-x", messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  if (out.ok) assert.equal((out.value as unknown as ModelCallResult).content, "good");
});

test("streaming performer: missing model id → loud {ok:false}, fetch never called", async () => {
  let called = false;
  const perf = anthropicStreamingModelPerformer({
    apiKey: "k",
    fetchImpl: (async () => {
      called = true;
      throw new Error("should not fetch");
    }) as unknown as typeof fetch,
  });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json); // no model anywhere
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error.message, /model/i);
  assert.equal(called, false, "the model check precedes the fetch");
});
