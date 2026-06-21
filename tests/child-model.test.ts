// M4 — per-child model resolution. resolveChildModel turns a subagents.json entry's
// optional overrides into the concrete {provider, model, baseUrl?, apiKey?, hasKey} that
// buildSubagents threads into provider.buffered(...). Pure, so the override matrix is
// covered without spawning a child: default (no overrides → today's selection), the
// Moonshot/Kimi heterogeneous case, a missing key → hasKey:false, and the loud-on-unknown
// prefix guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChildModel, type SubagentEntry } from "iris-runtime";

test("default (no overrides): provider/model from the image id, standard key, no baseUrl, apiKey NOT surfaced", () => {
  const entry: SubagentEntry = { name: "pm", image: "./pm" };
  const r = resolveChildModel(entry, "anthropic/claude-opus-4-8", { ANTHROPIC_API_KEY: "sk-ant" });
  assert.equal(r.providerName, "anthropic");
  assert.equal(r.model, "claude-opus-4-8", "prefix stripped to the bare id the provider wants");
  assert.equal(r.baseUrl, undefined, "no override → provider default endpoint");
  assert.equal(r.hasKey, true, "standard key present → real provider");
  assert.equal(r.apiKey, undefined, "no custom apiKeyEnv → key omitted; provider reads ANTHROPIC_API_KEY itself (byte-identical buffered({model}))");
});

test("bare image id → anthropic default, hasKey from ANTHROPIC_API_KEY", () => {
  const r = resolveChildModel({ name: "x", image: "./x" }, "claude-3", { ANTHROPIC_API_KEY: "k" });
  assert.equal(r.providerName, "anthropic");
  assert.equal(r.model, "claude-3");
  assert.equal(r.hasKey, true);
});

test("Moonshot/Kimi override: model + baseUrl + a per-child apiKeyEnv all take effect", () => {
  const entry: SubagentEntry = {
    name: "engineer",
    image: "./eng",
    model: "openai/kimi-k2",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
  };
  // OPENAI_API_KEY present but must NOT be used — the entry names its own key env.
  const r = resolveChildModel(entry, "anthropic/claude-opus-4-8", {
    MOONSHOT_API_KEY: "sk-moon",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-ant",
  });
  assert.equal(r.providerName, "openai", "provider from the OVERRIDE model id, not the image");
  assert.equal(r.model, "kimi-k2");
  assert.equal(r.baseUrl, "https://api.moonshot.ai/v1");
  assert.equal(r.apiKey, "sk-moon", "the per-child apiKeyEnv wins over the standard OPENAI/ANTHROPIC keys");
  assert.equal(r.hasKey, true);
});

test("missing key (apiKeyEnv unset in env) → hasKey:false, no apiKey (caller falls back to fake echo)", () => {
  const entry: SubagentEntry = { name: "engineer", image: "./eng", model: "openai/kimi-k2", apiKeyEnv: "MOONSHOT_API_KEY" };
  const r = resolveChildModel(entry, "anthropic/x", {}); // MOONSHOT_API_KEY absent
  assert.equal(r.providerName, "openai");
  assert.equal(r.hasKey, false);
  assert.equal(r.apiKey, undefined, "no key spread into buffered opts when absent");
});

test("empty-string key → hasKey:false (treated as absent)", () => {
  const r = resolveChildModel({ name: "x", image: "./x" }, "anthropic/x", { ANTHROPIC_API_KEY: "" });
  assert.equal(r.hasKey, false);
});

test("unknown provider prefix in the override → loud throw (no silent wrong-API POST)", () => {
  const entry: SubagentEntry = { name: "x", image: "./x", model: "gemini/pro" };
  assert.throws(() => resolveChildModel(entry, "anthropic/x", {}), /unknown model provider prefix/i);
});
