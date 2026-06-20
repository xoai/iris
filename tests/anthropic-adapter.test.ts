import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import { anthropicModelPerformer } from "@irisrun/provider-anthropic";
import type { ModelCallResult } from "@irisrun/provider-anthropic";

// Real adapter — request shaping + response parsing via an INJECTED fake fetch.
// No network, no key. (The real network path is manual-only, with a key.)

test("anthropic-adapter: shapes the request and parses the response", async () => {
  let captured: { url: string; init: { headers: Record<string, string>; body: string } } | null =
    null;
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        role: "assistant",
        content: [
          { type: "text", text: "Hi" },
          { type: "text", text: " there" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    };
  }) as unknown as typeof fetch;

  const perf = anthropicModelPerformer({
    apiKey: "sk-test",
    fetchImpl: fakeFetch,
    version: "2023-06-01",
  });
  const req: Json = {
    model: "claude-x",
    system: "be brief",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 64,
  };
  const out = await perf(req);
  assert.ok(out.ok);
  if (out.ok) {
    const r = out.value as unknown as ModelCallResult;
    assert.equal(r.content, "Hi there"); // text blocks joined
    assert.equal(r.stopReason, "end_turn");
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 2 });
  }
  assert.ok(captured);
  const cap = captured as { url: string; init: { headers: Record<string, string>; body: string } };
  assert.match(cap.url, /\/v1\/messages$/);
  assert.equal(cap.init.headers["x-api-key"], "sk-test");
  assert.equal(cap.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(cap.init.body) as Record<string, unknown>;
  assert.equal(body.model, "claude-x");
  assert.equal(body.system, "be brief");
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("anthropic-adapter: non-2xx → recordable {ok:false}", async () => {
  const fakeFetch = (async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  const perf = anthropicModelPerformer({ apiKey: "k", fetchImpl: fakeFetch });
  const out = await perf({ model: "x", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error.code, "429");
});

test("anthropic-adapter: buffered performer falls back to opts.model when the request carries none (edge worker path)", async () => {
  let sentModel: unknown = "UNSENT";
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    sentModel = (JSON.parse(init.body) as Record<string, unknown>).model;
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    };
  }) as unknown as typeof fetch;
  const perf = anthropicModelPerformer({ apiKey: "k", fetchImpl: fakeFetch, model: "claude-x" });
  // the harness model_call request carries NO model — opts.model must fill in
  const out = await perf({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(out.ok);
  assert.equal(sentModel, "claude-x", "opts.model was sent (not undefined)");
});

test("anthropic-adapter: buffered performer with NO model (request nor opts) → loud {ok:false}, no fetch", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const perf = anthropicModelPerformer({ apiKey: "k", fetchImpl: fakeFetch });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error.message, /no model id/);
  assert.equal(called, false, "no request was sent without a model");
});

test("anthropic-adapter: no key AND no fetchImpl → throws at construction", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => anthropicModelPerformer({}), /no ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
