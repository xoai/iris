// Per-child model resolution — turns a `subagents.json` entry's OPTIONAL overrides
// (model / baseUrl / apiKeyEnv) into the concrete `{provider, model, baseUrl?, apiKey?}`
// `buildSubagents` (cli-main.ts) threads into `provider.buffered(...)`. Pure so the
// override matrix (default vs. override, the Moonshot/Kimi case, a missing key) is
// unit-tested without spawning a child. Host-side; no node: builtins.
//
// Resolution, in one place:
//   model id   = entry.model ?? imageModelId         (override wins; keeps the prefix)
//   provider   = providerNameForModel(model id)      (loud on an unknown prefix)
//   key env    = entry.apiKeyEnv ?? provider's standard env key
//   hasKey     = that env var is a non-empty string  (else → keyless fake echo upstream)
//   model      = stripModelPrefix(model id)           (the bare id the provider wants)
//
// `apiKey` is surfaced ONLY when a CUSTOM `apiKeyEnv` is named. For the standard key
// the provider performer reads the same env var itself, so a child with no overrides
// resolves to `{ providerName, model, hasKey }` → `buffered({ model })`, byte-identical
// to the prior single-provider selection.
import { providerNameForModel, providerDescriptor, stripModelPrefix } from "./providers.ts";
import type { ProviderName } from "./providers.ts";
import type { SubagentEntry } from "./subagents-cfg.ts";

export interface ChildModelConfig {
  providerName: ProviderName;
  model: string; // prefix-stripped, as the provider performer expects
  baseUrl?: string; // per-child endpoint override (absent → provider default)
  apiKey?: string; // present only when hasKey (so it can spread into buffered opts)
  hasKey: boolean; // false → caller falls back to the keyless fake echo model
}

export function resolveChildModel(
  entry: SubagentEntry,
  imageModelId: string,
  env: Record<string, string | undefined>,
): ChildModelConfig {
  const modelId = entry.model ?? imageModelId;
  const providerName = providerNameForModel(modelId);
  const keyEnv = entry.apiKeyEnv ?? providerDescriptor(providerName).envKey;
  const apiKey = env[keyEnv];
  const hasKey = typeof apiKey === "string" && apiKey !== "";
  return {
    providerName,
    model: stripModelPrefix(modelId),
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    // Surface the key only for a CUSTOM apiKeyEnv; the standard key is read by the
    // provider itself, keeping the no-override `buffered({ model })` call byte-identical.
    ...(entry.apiKeyEnv !== undefined && hasKey ? { apiKey } : {}),
    hasKey,
  };
}
