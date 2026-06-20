// Provider-selection seam (packages/cli/src/providers.ts) — the prefix→provider
// mapping that makes "bring your own model" real. Pure fns + the dynamic-import
// loader. Imported from "iris-runtime" (re-exported from the cli index).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import {
  providerNameForModel,
  stripModelPrefix,
  providerDescriptor,
  loadModelProvider,
} from "iris-runtime";

test("providerNameForModel: known prefixes, bare default, unknown throws", () => {
  assert.equal(providerNameForModel("anthropic/claude-x"), "anthropic");
  assert.equal(providerNameForModel("openai/gpt-x"), "openai");
  assert.equal(providerNameForModel("claude-x"), "anthropic", "a bare id defaults to anthropic");
  assert.throws(() => providerNameForModel("gemini/pro"), /unknown model provider prefix "gemini\/"/);
});

test("stripModelPrefix: strips one leading provider segment; idempotent on bare ids", () => {
  assert.equal(stripModelPrefix("anthropic/claude-x"), "claude-x");
  assert.equal(stripModelPrefix("openai/gpt-4o"), "gpt-4o");
  assert.equal(stripModelPrefix("bare-id"), "bare-id");
});

test("providerDescriptor: per-provider package, env key, and export names", () => {
  assert.deepEqual(providerDescriptor("openai"), {
    name: "openai",
    envKey: "OPENAI_API_KEY",
    pkg: "@irisrun/provider-openai",
    bufferedExport: "openaiModelPerformer",
    streamingExport: "openaiStreamingModelPerformer",
  });
  assert.deepEqual(providerDescriptor("anthropic"), {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    pkg: "@irisrun/provider-anthropic",
    bufferedExport: "anthropicModelPerformer",
    streamingExport: "anthropicStreamingModelPerformer",
  });
});

// A capturing fake fetch that records the URL and returns a minimal valid body for
// whichever provider is calling (both performers tolerate the extra/absent fields).
function captureUrl(captured: { url: string | null }): typeof fetch {
  return (async (url: string) => {
    captured.url = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "ok" }], // anthropic shape
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }], // openai shape
        stop_reason: "end_turn",
      }),
    };
  }) as unknown as typeof fetch;
}

test("loadModelProvider('openai') loads the OpenAI package and routes to its endpoint", async () => {
  const loaded = await loadModelProvider("openai");
  assert.equal(loaded.name, "openai");
  assert.equal(typeof loaded.buffered, "function");
  assert.equal(typeof loaded.streaming, "function");
  const cap = { url: null as string | null };
  const perf = loaded.buffered({ apiKey: "k", fetchImpl: captureUrl(cap), model: "gpt-x" });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  assert.match(cap.url ?? "", /\/v1\/chat\/completions$/, "routed to the OpenAI endpoint");
});

test("loadModelProvider('anthropic') loads the Anthropic package and routes to its endpoint", async () => {
  const loaded = await loadModelProvider("anthropic");
  assert.equal(loaded.name, "anthropic");
  const cap = { url: null as string | null };
  const perf = loaded.buffered({ apiKey: "k", fetchImpl: captureUrl(cap), model: "claude-x" });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  assert.match(cap.url ?? "", /\/v1\/messages$/, "routed to the Anthropic endpoint");
});
