// model_call request/result shapes. Plain interfaces — they describe
// the JSON that crosses the effect boundary (request: Json, result value: Json)
// but are NOT declared `extends Record<string,Json>` so optional fields don't
// fight the index signature. The performer casts Json ↔ these at the boundary.

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
  content: string; // text blocks joined
  stopReason: string; // e.g. "end_turn" | "max_tokens"
  usage?: { inputTokens: number; outputTokens: number };
}
