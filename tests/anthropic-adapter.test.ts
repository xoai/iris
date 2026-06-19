import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@iris/core";
import { anthropicModelPerformer } from "@iris/provider-anthropic";
import type { ModelCallResult } from "@iris/provider-anthropic";

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

test("anthropic-adapter: no key AND no fetchImpl → throws at construction", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => anthropicModelPerformer({}), /no ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
