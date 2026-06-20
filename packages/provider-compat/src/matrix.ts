// The provider compatibility matrix. A conformance-VERIFIED
// registry of endpoints that speak one of the two protocols Iris already supports —
// OpenAI Chat Completions or Anthropic Messages — classified by whether they are
// replay-safe out of the box or need auth/URL/transport adaptation first.
//
// WHY THIS IS ON-MOAT, NOT A CHECKLIST: every other framework can SAY
// "OpenAI-compatible". Iris must mean it precisely, because a model reply is a
// recorded journal effect that has to replay byte-identically — so the
// canonicalization layer is exactly where "compatible" quietly breaks. This matrix
// turns the loose claim into a tested guarantee: each entry's representative response
// shape is run through the matching adapter in CI (tests/provider-compat-matrix.test.ts)
// and must canonicalize to the stable ModelCallResult, or be flagged here with the
// specific divergence. The matrix is conformance-tested data, never a static doc that
// rots into a false promise.
//
// "replay-safe" is a claim about FAITHFUL CAPTURE + CANONICALIZATION —
// NOT that the endpoint is deterministic. Point Iris's --base-url at a replay-safe
// endpoint with its key and the recorded session replays byte-identically.

/** The wire shape an endpoint speaks — which adapter handles it. NOT the vendor. */
export type Protocol = "openai" | "anthropic";

/**
 * - "replay-safe": works out of the box — point `--base-url` at `baseUrl` with the
 *   endpoint's key. Standard auth (Bearer / x-api-key) and a standard path; the
 *   representative response canonicalizes to the stable result. `note` is "".
 * - "known-divergent": the RESPONSE shape still canonicalizes, but reaching it needs
 *   auth/URL/transport adaptation the plain adapter does not provide (a signing proxy,
 *   a templated URL, a non-Bearer header). `note` names the divergence — never empty.
 */
export type ReplaySafety = "replay-safe" | "known-divergent";

export interface CompatEntry {
  /** stable key, e.g. "groq", "azure-openai" (lowercase, kebab). */
  id: string;
  /** human label, e.g. "Groq". */
  label: string;
  /** which adapter speaks it. */
  protocol: Protocol;
  /** the FULL endpoint URL the adapter POSTs to verbatim (NOT a host base). */
  baseUrl: string;
  /** the API-key env-var convention (documentation only). */
  envKey: string;
  replaySafety: ReplaySafety;
  /** the specific divergence for "known-divergent"; "" for "replay-safe". */
  note: string;
}

// OpenAI Chat Completions protocol (POST <baseUrl> with a Bearer key; body
// {model,messages,max_tokens}). The full URL ends with /chat/completions for every
// replay-safe entry — point --base-url straight at it.
const OPENAI_ENTRIES: readonly CompatEntry[] = [
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    envKey: "GROQ_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "together",
    label: "Together AI",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    envKey: "TOGETHER_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
    envKey: "FIREWORKS_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    envKey: "OPENROUTER_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    envKey: "MISTRAL_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1/chat/completions",
    envKey: "XAI_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "vllm",
    label: "vLLM (self-hosted)",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1/chat/completions",
    envKey: "VLLM_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "ollama",
    label: "Ollama (self-hosted)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    envKey: "OLLAMA_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "lmstudio",
    label: "LM Studio (self-hosted)",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1/chat/completions",
    envKey: "LMSTUDIO_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    protocol: "openai",
    baseUrl:
      "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-10-21",
    envKey: "AZURE_OPENAI_API_KEY",
    replaySafety: "known-divergent",
    note: "URL is templated per resource/deployment and carries an ?api-version query; auth uses the `api-key` header, NOT a Bearer token. The response shape is standard, so it canonicalizes once auth/URL are adapted (a proxy or a future per-endpoint auth option).",
  },
];

// Anthropic Messages protocol (POST <baseUrl> with x-api-key + anthropic-version;
// body {model,system?,messages,max_tokens}). The full URL ends with /messages for
// the replay-safe entry.
const ANTHROPIC_ENTRIES: readonly CompatEntry[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    replaySafety: "replay-safe",
    note: "",
  },
  {
    id: "bedrock-claude",
    label: "AWS Bedrock (Claude)",
    protocol: "anthropic",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/model/MODEL-ID/invoke",
    envKey: "AWS_BEARER_TOKEN_BEDROCK",
    replaySafety: "known-divergent",
    note: "AWS SigV4 (or a bearer) auth and a /model/{id}/invoke path, not x-api-key + /v1/messages. Needs a signing proxy; once the Messages-shaped response is reached it canonicalizes.",
  },
  {
    id: "vertex-claude",
    label: "Google Vertex AI (Claude)",
    protocol: "anthropic",
    baseUrl:
      "https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR-PROJECT/locations/us-central1/publishers/anthropic/models/MODEL-ID:rawPredict",
    envKey: "GOOGLE_APPLICATION_CREDENTIALS",
    replaySafety: "known-divergent",
    note: "GCP OAuth bearer, a projects/locations path, and `anthropic_version` in the body instead of the header. Needs a GCP-auth proxy; the Messages-shaped response then canonicalizes.",
  },
];

/** The full matrix, frozen. Row order is stable (used by the deterministic render). */
export const COMPAT_MATRIX: readonly CompatEntry[] = Object.freeze([
  ...OPENAI_ENTRIES,
  ...ANTHROPIC_ENTRIES,
]);

/** Entries that speak a given protocol, in matrix order. */
export function entriesByProtocol(p: Protocol): CompatEntry[] {
  return COMPAT_MATRIX.filter((e) => e.protocol === p);
}

/** The entry with a given id, or undefined. */
export function findEntry(id: string): CompatEntry | undefined {
  return COMPAT_MATRIX.find((e) => e.id === id);
}
