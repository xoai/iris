// Shared model-provider CONFORMANCE suite — the literal realization of the
// "done when": "two providers pass the SAME conformance tests behind the model
// port." Both @irisrun/provider-anthropic and @irisrun/provider-openai run this exact set
// of behavioral assertions; only provider-specific surface (URL, auth header, body
// field names, SSE event shape, default stopReason value) comes from the fixture.
//
// IMPORTANT: `runModelProviderConformance` calls node:test `test()` SYNCHRONOUSLY
// in its body. The importing `*.test.ts` calls it at module-load time, so the tests
// register during import (node:test requires synchronous registration) — never wrap
// these in an async IIFE or a deferred callback.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, Performer } from "@irisrun/core";

// A minimal structural view of a parsed ModelCallResult (both providers' shapes).
interface Result {
  role: string;
  content: string;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ConformanceFixture {
  name: string;
  envKey: string; // e.g. "OPENAI_API_KEY" — used by the construction-throw test
  makeBuffered(opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    model?: string;
  }): Performer;
  makeStreaming(opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    model?: string;
    onDelta?: (t: string) => void;
  }): Performer;
  // The provider-specific HTTP-200 buffered JSON body for the canonical turn
  // (content "Hi there", usage in:5 out:2).
  bufferedResponseBody(): unknown;
  // An SSE text body streaming "Hi" then " there" (+ usage in:5 out:2 + stop).
  streamingSseBody(): string;
  // A non-SSE buffered JSON body for the streaming fallback test
  // (content "Hello", usage in:3 out:4).
  fallbackResponseBody(): unknown;
  // An SSE body whose FIRST data frame is malformed, then one "good" delta + stop.
  malformedSseBody(): string;
  expected: { content: string; stopReason: string; usage: { inputTokens: number; outputTokens: number } };
  expectedFallback: { content: string; usage: { inputTokens: number; outputTokens: number } };
  // Provider-specific request-shape assertions over the captured buffered request.
  assertRequestShape(captured: Captured, sentApiKey: string): void;
  // Extract the model id the request actually sent (for the opts.model tests).
  modelFromBody(body: Record<string, unknown>): unknown;
}

function captureBufferedFetch(
  bodyObj: unknown,
  captured: { value: Captured | null },
): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    captured.value = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    return { ok: true, status: 200, json: async () => bodyObj };
  }) as unknown as typeof fetch;
}

function sseFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

function captureSseFetch(body: string, captured: { value: Captured | null }): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    captured.value = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

export function runModelProviderConformance(fx: ConformanceFixture): void {
  const P = `[conformance:${fx.name}]`;

  test(`${P} buffered: shapes the request and parses the response`, async () => {
    const cap: { value: Captured | null } = { value: null };
    const perf = fx.makeBuffered({
      apiKey: "sk-test",
      fetchImpl: captureBufferedFetch(fx.bufferedResponseBody(), cap),
    });
    const out = await perf({
      model: "model-x",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
    } as Json);
    assert.ok(out.ok, "buffered call succeeded");
    if (out.ok) {
      const r = out.value as unknown as Result;
      assert.equal(r.content, fx.expected.content);
      assert.equal(r.stopReason, fx.expected.stopReason);
      assert.deepEqual(r.usage, fx.expected.usage);
    }
    assert.ok(cap.value, "the request was captured");
    fx.assertRequestShape(cap.value as Captured, "sk-test");
  });

  test(`${P} buffered: falls back to opts.model when the request carries none`, async () => {
    const cap: { value: Captured | null } = { value: null };
    const perf = fx.makeBuffered({
      apiKey: "k",
      fetchImpl: captureBufferedFetch(fx.bufferedResponseBody(), cap),
      model: "model-from-opts",
    });
    // the harness model_call request carries NO model — opts.model must fill in
    const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
    assert.ok(out.ok);
    assert.equal(fx.modelFromBody((cap.value as Captured).body), "model-from-opts");
  });

  test(`${P} buffered: no model (request nor opts) → loud {ok:false}, no fetch`, async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const perf = fx.makeBuffered({ apiKey: "k", fetchImpl });
    const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error.message, /no model id/);
    assert.equal(called, false, "no request was sent without a model");
  });

  test(`${P} buffered: non-2xx → recordable {ok:false} with the status code`, async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const perf = fx.makeBuffered({ apiKey: "k", fetchImpl });
    const out = await perf({ model: "x", messages: [{ role: "user", content: "hi" }] } as Json);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.code, "429");
  });

  test(`${P} construction: no key AND no fetchImpl → throws`, () => {
    const saved = process.env[fx.envKey];
    delete process.env[fx.envKey];
    try {
      assert.throws(() => fx.makeBuffered({}), new RegExp(fx.envKey));
    } finally {
      if (saved !== undefined) process.env[fx.envKey] = saved;
    }
  });

  test(`${P} streaming: parses SSE, onDelta in order, content === join(deltas)`, async () => {
    const deltas: string[] = [];
    const perf = fx.makeStreaming({
      apiKey: "sk-test",
      fetchImpl: sseFetch(fx.streamingSseBody()),
      onDelta: (t) => deltas.push(t),
    });
    const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
    assert.ok(out.ok);
    if (out.ok) {
      const r = out.value as unknown as Result;
      assert.deepEqual(deltas, ["Hi", " there"]);
      assert.equal(r.content, fx.expected.content);
      assert.equal(deltas.join(""), r.content, "reconcile invariant: content == join(deltas)");
      assert.equal(r.stopReason, fx.expected.stopReason);
      assert.deepEqual(r.usage, fx.expected.usage);
    }
  });

  test(`${P} streaming: opts.model used when the request carries none`, async () => {
    const cap: { value: Captured | null } = { value: null };
    const perf = fx.makeStreaming({
      apiKey: "k",
      fetchImpl: captureSseFetch(fx.streamingSseBody(), cap),
      model: "model-from-lock",
    });
    const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json); // NO model
    assert.ok(out.ok);
    assert.equal(fx.modelFromBody((cap.value as Captured).body), "model-from-lock");
  });

  test(`${P} streaming: non-SSE content-type → buffered fallback, ONE delta`, async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fx.fallbackResponseBody()), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const perf = fx.makeStreaming({ apiKey: "k", fetchImpl, onDelta: (t) => deltas.push(t) });
    const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
    assert.ok(out.ok);
    if (out.ok) {
      const r = out.value as unknown as Result;
      assert.equal(r.content, fx.expectedFallback.content);
      assert.deepEqual(deltas, [fx.expectedFallback.content], "exactly one delta with the whole text");
      assert.deepEqual(r.usage, fx.expectedFallback.usage);
    }
  });

  test(`${P} streaming: a malformed data frame is SKIPPED, not thrown`, async () => {
    const perf = fx.makeStreaming({ apiKey: "k", fetchImpl: sseFetch(fx.malformedSseBody()) });
    const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
    assert.ok(out.ok);
    if (out.ok) assert.equal((out.value as unknown as Result).content, "good");
  });

  test(`${P} streaming: missing model id → loud {ok:false}, fetch never called`, async () => {
    let called = false;
    const perf = fx.makeStreaming({
      apiKey: "k",
      fetchImpl: (async () => {
        called = true;
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json); // no model
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error.message, /model/i);
    assert.equal(called, false, "the model check precedes the fetch");
  });

  test(`${P} result SHAPE is exactly {role,content,stopReason,usage?}`, async () => {
    const cap: { value: Captured | null } = { value: null };
    const perf = fx.makeBuffered({
      apiKey: "k",
      fetchImpl: captureBufferedFetch(fx.bufferedResponseBody(), cap),
    });
    const out = await perf({ model: "x", messages: [{ role: "user", content: "hi" }] } as Json);
    assert.ok(out.ok);
    if (out.ok) {
      const r = out.value as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(r).sort(),
        ["content", "role", "stopReason", "usage"],
        "exactly the four port fields (usage present for this fixture)",
      );
      assert.equal(r.role, "assistant");
      assert.deepEqual(
        Object.keys(r.usage as Record<string, unknown>).sort(),
        ["inputTokens", "outputTokens"],
        "usage has exactly the two port fields",
      );
    }
  });
}
