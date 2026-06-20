// @irisrun/provider-anthropic — model_call performer.
export const PACKAGE = "@irisrun/provider-anthropic";
export type { ModelCallRequest, ModelCallResult, ModelMessage } from "./types.ts";
export { anthropicModelPerformer, anthropicStreamingModelPerformer } from "./anthropic.ts";
export type { AnthropicOptions, AnthropicStreamingOptions } from "./anthropic.ts";
export { readAnthropicSse } from "./sse.ts";
export type { AnthropicStreamAccumulator } from "./sse.ts";
