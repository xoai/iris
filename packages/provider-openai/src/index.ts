// @iris/provider-openai — model_call performer (OpenAI Chat Completions). A peer of
// @iris/provider-anthropic behind the same model port; both pass the shared
// conformance suite (tests/lib/model-provider-conformance.ts).
export const PACKAGE = "@iris/provider-openai";
export type { ModelCallRequest, ModelCallResult, ModelMessage } from "./types.ts";
export { openaiModelPerformer, openaiStreamingModelPerformer } from "./openai.ts";
export type { OpenAiOptions, OpenAiStreamingOptions } from "./openai.ts";
export { readOpenAiSse } from "./sse.ts";
export type { OpenAiStreamAccumulator } from "./sse.ts";
