// Provider-selection seam (packages/cli/src/providers.ts) — the prefix→provider
// mapping that makes "bring your own model" real. Pure fns + the dynamic-import
// loader. Imported from "iris-runtime" (re-exported from the cli index).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { Json } from "@irisrun/core";
import {
  providerNameForModel,
  stripModelPrefix,
  providerDescriptor,
  loadModelProvider,
  resolveProvider,
  assertDeployFlagsSupported,
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

// --base-url (deploy-time endpoint override) flows through the seam to the
// performer, redirecting WHERE the protocol's request is sent — the mechanism behind
// `iris run/serve/chat --base-url`. The model-id prefix still selects the protocol.
test("loadModelProvider forwards baseUrl to the buffered performer (deploy-time endpoint override)", async () => {
  const loaded = await loadModelProvider("openai");
  const cap = { url: null as string | null };
  const custom = "https://api.groq.com/openai/v1/chat/completions";
  const perf = loaded.buffered({ apiKey: "k", fetchImpl: captureUrl(cap), model: "gpt-x", baseUrl: custom });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  assert.equal(cap.url, custom, "the OpenAI-protocol request was redirected to the custom endpoint");
});

test("loadModelProvider forwards baseUrl to the streaming performer too", async () => {
  const loaded = await loadModelProvider("anthropic");
  const cap = { url: null as string | null };
  const custom = "https://my-proxy.example/v1/messages";
  const perf = loaded.streaming({ apiKey: "k", fetchImpl: captureUrl(cap), model: "claude-x", baseUrl: custom });
  const out = await perf({ messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok);
  assert.equal(cap.url, custom, "the streaming Anthropic-protocol request was redirected");
});

// (Gate-3 follow-up): pin the THREE cli-main `--base-url` call sites. The seam tests
// above prove baseUrl is forwarded to the performer; this guards the cli-main wiring
// (run/serve/chat) — a regression dropping baseUrl from any provider.buffered/streaming
// construction would otherwise pass unnoticed. Source-assertion, like docs-funnel.
test("every provider.buffered/streaming construction in cli-main passes baseUrl", () => {
  const cliMain = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "cli-main.ts"),
    "utf8",
  );
  const lines = cliMain.split("\n").filter((l) => /provider\.(buffered|streaming)\(/.test(l));
  assert.ok(lines.length >= 3, `expected the 3 base-url call sites (run/serve/chat), found ${lines.length}`);
  for (const l of lines) {
    assert.match(l, /baseUrl/, `a provider performer is constructed WITHOUT baseUrl: ${l.trim()}`);
  }
});

// --- the forkless `--provider <module>` loader (resolveProvider) -------------
test("resolveProvider: default (no --provider) selects the built-in by prefix", async () => {
  const loaded = await resolveProvider(undefined, "anthropic/claude-x");
  assert.equal(loaded.name, "anthropic");
  assert.equal(typeof loaded.buffered, "function");
  assert.equal(typeof loaded.streaming, "function");
});

test("resolveProvider: a --provider <module> exporting openModelProvider is loaded (forkless, any prefix)", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = pathToFileURL(join(here, "lib", "fake-provider-module.ts")).href;
  // an unknown THIRD-PARTY prefix that providerNameForModel would reject — the module
  // path must NOT consult it (the prefix is only stripped for the API).
  const loaded = await resolveProvider(spec, "acme/whatever");
  assert.equal(loaded.name, spec, "the LoadedProvider name carries the module specifier");
  const out = await loaded.buffered({ model: "x" })({ messages: [{ role: "user", content: "hi" }] } as Json);
  assert.ok(out.ok && (out.value as { content?: string }).content === "fake");
});

test("resolveProvider: a module without openModelProvider fails loudly", async () => {
  await assert.rejects(resolveProvider("@irisrun/core", "x"), /must export openModelProvider/);
});

test("resolveProvider: an unresolvable module fails loudly", async () => {
  await assert.rejects(resolveProvider("@irisrun/provider-does-not-exist-xyz", "x"), /could not import/);
});

// `iris deploy` refuses forkless --provider/--channel BEHAVIORALLY (the spec's testing
// strategy named this) — the worker bakes a built-in provider and the prefix would throw
// first, so the guard fires up front. deployCommand (an un-importable argv wrapper) calls
// this exported guard.
test("assertDeployFlagsSupported: refuses forkless --provider/--channel, allows neither", () => {
  assert.throws(() => assertDeployFlagsSupported({ provider: "@acme/iris-provider-foo" }), /not supported at deploy time/);
  assert.throws(() => assertDeployFlagsSupported({ channel: "@acme/iris-channel-grpc" }), /not supported at deploy time/);
  assert.doesNotThrow(() => assertDeployFlagsSupported({}));
});

// Wiring guard (source assertion, like the base-url guard above): --provider is threaded
// through the run/serve/chat sites, and deployCommand calls the behavioral guard above.
test("cli-main threads --provider through run/serve/chat, and deploy calls the guard", () => {
  const cliMain = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "cli-main.ts"),
    "utf8",
  );
  const calls = cliMain.split("\n").filter((l) => /resolveProvider\(/.test(l));
  assert.ok(calls.length >= 3, `expected resolveProvider at the run/serve/chat sites, found ${calls.length}`);
  const deploySection = cliMain.slice(cliMain.indexOf("async function deployCommand"));
  assert.match(
    deploySection.slice(0, 900),
    /assertDeployFlagsSupported\(/,
    "deployCommand must call assertDeployFlagsSupported before cmdDeploy",
  );
});
