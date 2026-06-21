// Provider selection seam — turns the `<provider>/` model-id prefix into a real
// "bring your own model" choice. The prefix ("anthropic/claude-x", "openai/gpt-x")
// was previously only STRIPPED (iris.ts); here it also SELECTS which model_call
// provider to load. Used by `iris run/serve/chat` and (via providerDescriptor) the
// generated deploy worker. Pure functions are unit-tested; loadModelProvider
// dynamic-imports the chosen package so the no-key path stays light.
import type { Performer } from "@irisrun/core";
import type { ModelPerformerOptions, StreamingModelPerformerOptions } from "@irisrun/provider-conformance";

export type ProviderName = "anthropic" | "openai";

export interface ProviderDescriptor {
  name: ProviderName;
  envKey: string; // the API-key env var the real path reads
  pkg: string; // the npm package to import
  bufferedExport: string; // the buffered model_call performer export
  streamingExport: string; // the streaming model_call performer export
}

const DESCRIPTORS: Record<ProviderName, ProviderDescriptor> = {
  anthropic: {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    pkg: "@irisrun/provider-anthropic",
    bufferedExport: "anthropicModelPerformer",
    streamingExport: "anthropicStreamingModelPerformer",
  },
  openai: {
    name: "openai",
    envKey: "OPENAI_API_KEY",
    pkg: "@irisrun/provider-openai",
    bufferedExport: "openaiModelPerformer",
    streamingExport: "openaiStreamingModelPerformer",
  },
};

/**
 * Map a model id to its provider via the `<provider>/` prefix. A BARE id (no
 * slash) → "anthropic" (backward-compatible default for pre-prefix images). A
 * KNOWN prefix → that provider. Any OTHER prefix throws LOUDLY — never a silent
 * default that would POST to the wrong API (no-silent-failures).
 */
export function providerNameForModel(modelId: string): ProviderName {
  const slash = modelId.indexOf("/");
  if (slash < 0) return "anthropic";
  const prefix = modelId.slice(0, slash);
  if (prefix === "anthropic" || prefix === "openai") return prefix;
  throw new Error(
    `unknown model provider prefix "${prefix}/" in model id "${modelId}" — supported: "anthropic/", "openai/" (or a bare id → anthropic)`,
  );
}

/** Strip a leading `<provider>/` segment ("anthropic/claude-x" → "claude-x"); idempotent. */
export function stripModelPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/** The static descriptor for a provider (used by the deploy worker generator). */
export function providerDescriptor(name: ProviderName): ProviderDescriptor {
  return DESCRIPTORS[name];
}

// ModelPerformerOptions / StreamingModelPerformerOptions are canonical in
// @irisrun/provider-conformance (the provider port package); re-exported here so the
// CLI public surface (index.ts) keeps resolving them from "./providers.ts".
export type { ModelPerformerOptions, StreamingModelPerformerOptions } from "@irisrun/provider-conformance";

export interface LoadedProvider {
  name: ProviderName;
  buffered(opts?: ModelPerformerOptions): Performer;
  streaming(opts?: StreamingModelPerformerOptions): Performer;
}

/**
 * Dynamic-import a provider package and normalize its two export names into a
 * common `{buffered, streaming}` shape — one call site for run/serve/chat. The
 * import is lazy so the no-key / echo path never loads a provider.
 */
export async function loadModelProvider(name: ProviderName): Promise<LoadedProvider> {
  const desc = DESCRIPTORS[name];
  const mod = (await import(desc.pkg)) as Record<string, unknown>;
  const buffered = mod[desc.bufferedExport];
  const streaming = mod[desc.streamingExport];
  if (typeof buffered !== "function" || typeof streaming !== "function") {
    throw new Error(
      `provider ${desc.pkg} is missing expected exports (${desc.bufferedExport}, ${desc.streamingExport})`,
    );
  }
  const bufferedFn = buffered as (opts?: ModelPerformerOptions) => Performer;
  const streamingFn = streaming as (opts?: StreamingModelPerformerOptions) => Performer;
  return {
    name,
    buffered: (opts?: ModelPerformerOptions): Performer => bufferedFn(opts),
    streaming: (opts?: StreamingModelPerformerOptions): Performer => streamingFn(opts),
  };
}
