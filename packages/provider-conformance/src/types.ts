// Types for the portable model-provider conformance suite, and the CANONICAL home
// for the model-port wire shapes + provider-factory option shapes. A provider author
// imports these here (or re-exported via @irisrun/sdk) and nowhere else. Depends only
// on @irisrun/core's `Performer` — never on a concrete provider — so it certifies
// first- and third-party adapters identically.
import type { Performer } from "@irisrun/core";

/** One conformance check. `fn` throws (via node:assert) on failure. The harness
 *  returns these and never imports a test runner, so a caller wires them into
 *  `node:test` (see `register`) or iterates them under any runner. */
export interface ConformanceCase {
  name: string;
  fn: () => Promise<void>;
}

// model_call request/result shapes — the JSON that crosses the effect boundary
// (request: Json, result value: Json) but NOT declared `extends Record<string,Json>`
// so optional fields don't fight an index signature. The performer casts Json ↔ these
// at the boundary. Canonical here; the provider packages keep identical copies.
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

/** Options a buffered model_call performer factory accepts. `fetchImpl` is the
 *  injection seam the suite drives (no network, no key); `baseUrl` redirects a
 *  compatible endpoint. */
export interface ModelPerformerOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
}

/** Streaming twin — adds a non-journaled live-UX delta sink. */
export interface StreamingModelPerformerOptions extends ModelPerformerOptions {
  onDelta?: (text: string) => void;
}

/** The captured buffered request a fixture asserts over. */
export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ConformanceFixture {
  name: string;
  envKey: string; // e.g. "OPENAI_API_KEY" — used by the construction-throw test
  makeBuffered(opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    model?: string;
  }): Performer;
  makeStreaming(opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    model?: string;
    onDelta?: (t: string) => void;
  }): Performer;
  // The provider-specific HTTP-200 buffered JSON body for the canonical turn
  // (content "Hi there", usage in:5 out:2).
  bufferedResponseBody(): unknown;
  // An SSE text body streaming "Hi" then " there" (+ usage in:5 out:2 + stop).
  streamingSseBody(): string;
  // A non-SSE buffered JSON body for the streaming fallback test
  // (content "Hello", usage in:3 out:4).
  fallbackResponseBody(): unknown;
  // An SSE body whose FIRST data frame is malformed, then one "good" delta + stop.
  malformedSseBody(): string;
  expected: { content: string; stopReason: string; usage: { inputTokens: number; outputTokens: number } };
  expectedFallback: { content: string; usage: { inputTokens: number; outputTokens: number } };
  // Provider-specific request-shape assertions over the captured buffered request.
  assertRequestShape(captured: Captured, sentApiKey: string): void;
  // Extract the model id the request actually sent (for the opts.model tests).
  modelFromBody(body: Record<string, unknown>): unknown;
}
