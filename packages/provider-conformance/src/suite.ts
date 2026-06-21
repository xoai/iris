// Shared model-provider CONFORMANCE suite — the literal realization of the
// "done when": "two providers pass the SAME conformance tests behind the model
// port." Both @irisrun/provider-anthropic and @irisrun/provider-openai run this exact
// set of behavioral assertions; only provider-specific surface (URL, auth header, body
// field names, SSE event shape, default stopReason value) comes from the fixture.
//
// Runner-agnostic: `runModelProviderConformance` RETURNS a list of cases and imports no
// test runner. A caller wires them in with `register(cases, test)` (see register.ts).
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import type { ConformanceCase, ConformanceFixture, Captured, ModelCallResult } from "./types.ts";

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

export function runModelProviderConformance(fx: ConformanceFixture): ConformanceCase[] {
  const P = `[conformance:${fx.name}]`;
  const cases: ConformanceCase[] = [];

  cases.push({
    name: `${P} buffered: shapes the request and parses the response`,
    fn: async () => {
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
        const r = out.value as unknown as ModelCallResult;
        assert.equal(r.content, fx.expected.content);
        assert.equal(r.stopReason, fx.expected.stopReason);
        assert.deepEqual(r.usage, fx.expected.usage);
      }
      assert.ok(cap.value, "the request was captured");
      fx.assertRequestShape(cap.value as Captured, "sk-test");
    },
  });

  cases.push({
    name: `${P} buffered: falls back to opts.model when the request carries none`,
    fn: async () => {
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
    },
  });

  cases.push({
    name: `${P} buffered: no model (request nor opts) → loud {ok:false}, no fetch`,
    fn: async () => {
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
    },
  });

  cases.push({
    name: `${P} buffered: non-2xx → recordable {ok:false} with the status code`,
    fn: async () => {
      const fetchImpl = (async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const perf = fx.makeBuffered({ apiKey: "k", fetchImpl });
      const out = await perf({ model: "x", messages: [{ role: "user", content: "hi" }] } as Json);
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.error.code, "429");
    },
  });

  cases.push({
    name: `${P} construction: no key AND no fetchImpl → throws`,
    fn: async () => {
      const saved = process.env[fx.envKey];
      delete process.env[fx.envKey];
      try {
        assert.throws(() => fx.makeBuffered({}), new RegExp(fx.envKey));
      } finally {
        if (saved !== undefined) process.env[fx.envKey] = saved;
      }
    },
  });

  cases.push({
    name: `${P} streaming: parses SSE, onDelta in order, content === join(deltas)`,
    fn: async () => {
      const deltas: string[] = [];
      const perf = fx.makeStreaming({
        apiKey: "sk-test",
        fetchImpl: sseFetch(fx.streamingSseBody()),
        onDelta: (t) => deltas.push(t),
      });
      const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
      assert.ok(out.ok);
      if (out.ok) {
        const r = out.value as unknown as ModelCallResult;
        assert.deepEqual(deltas, ["Hi", " there"]);
        assert.equal(r.content, fx.expected.content);
        assert.equal(deltas.join(""), r.content, "reconcile invariant: content == join(deltas)");
        assert.equal(r.stopReason, fx.expected.stopReason);
        assert.deepEqual(r.usage, fx.expected.usage);
      }
    },
  });

  cases.push({
    name: `${P} streaming: opts.model used when the request carries none`,
    fn: async () => {
      const cap: { value: Captured | null } = { value: null };
      const perf = fx.makeStreaming({
        apiKey: "k",
        fetchImpl: captureSseFetch(fx.streamingSseBody(), cap),
        model: "model-from-lock",
      });
      const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json); // NO model
      assert.ok(out.ok);
      assert.equal(fx.modelFromBody((cap.value as Captured).body), "model-from-lock");
    },
  });

  cases.push({
    name: `${P} streaming: non-SSE content-type → buffered fallback, ONE delta`,
    fn: async () => {
      const deltas: string[] = [];
      const fetchImpl = (async () =>
        new Response(JSON.stringify(fx.fallbackResponseBody()), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const perf = fx.makeStreaming({ apiKey: "k", fetchImpl, onDelta: (t) => deltas.push(t) });
      const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
      assert.ok(out.ok);
      if (out.ok) {
        const r = out.value as unknown as ModelCallResult;
        assert.equal(r.content, fx.expectedFallback.content);
        assert.deepEqual(deltas, [fx.expectedFallback.content], "exactly one delta with the whole text");
        assert.deepEqual(r.usage, fx.expectedFallback.usage);
      }
    },
  });

  cases.push({
    name: `${P} streaming: a malformed data frame is SKIPPED, not thrown`,
    fn: async () => {
      const perf = fx.makeStreaming({ apiKey: "k", fetchImpl: sseFetch(fx.malformedSseBody()) });
      const out = await perf({ model: "model-x", messages: [{ role: "user", content: "hi" }] } as Json);
      assert.ok(out.ok);
      if (out.ok) assert.equal((out.value as unknown as ModelCallResult).content, "good");
    },
  });

  cases.push({
    name: `${P} streaming: missing model id → loud {ok:false}, fetch never called`,
    fn: async () => {
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
    },
  });

  cases.push({
    name: `${P} result SHAPE is exactly {role,content,stopReason,usage?}`,
    fn: async () => {
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
    },
  });

  return cases;
}
