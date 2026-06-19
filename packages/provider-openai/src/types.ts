// model_call request/result shapes — these MIRROR the model-port contract (cf.
// @iris/provider-anthropic/src/types.ts). The shared conformance suite
// (tests/lib/model-provider-conformance.ts) guarantees both providers honor the
// SAME shape, so the contract is DUPLICATED here rather than promoted into
// @iris/core — the engine/core stays untouched (an Iris invariant). The performer
// casts Json ↔ these at the effect boundary.

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelCallRequest {
  model: string;
  system?: string;
  messages: ModelMessage[];
  maxTokens?: number;
}

export interface ModelCallResult {
  role: "assistant";
  content: string; // text content joined
  stopReason: string; // OpenAI finish_reason, e.g. "stop" | "length"
  usage?: { inputTokens: number; outputTokens: number };
}
