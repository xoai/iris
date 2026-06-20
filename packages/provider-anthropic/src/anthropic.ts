// Direct Anthropic Messages adapter. Host-side; uses the
// built-in `fetch` (zero deps); `fetch` is injectable so unit tests run with no
// network/key. A missing key is a CONSTRUCTION-time config error (loud) — never
// a mid-turn laundered failure.
import type { Performer, Json, Outcome } from "@irisrun/core";
import type { ModelCallRequest, ModelCallResult } from "./types.ts";
import { readAnthropicSse } from "./sse.ts";

export interface AnthropicOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  version?: string;
  baseUrl?: string;
  // A fallback model id when the request carries none. The harness `model_call`
  // request is `{ messages }` (no model), so a STANDALONE caller (e.g. an edge
  // worker without wrapModelForImage) must bake the model in here. The request's
  // own `model` still wins. (The streaming variant has had this; the buffered one
  // now matches it — symmetry.)
  model?: string;
}

const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface ResolvedConfig {
  apiKey: string | undefined;
  doFetch: typeof fetch;
  version: string;
  url: string;
}

// Shared config resolution + CONSTRUCTION-time validation: a
// registered performer that threw at call time would be caught by the engine and
// laundered to {ok:false}, so these errors fire at construction. Both the buffered
// and the streaming performer go through this — identical posture.
function resolveConfig(opts: AnthropicOptions, label: string): ResolvedConfig {
  const apiKey =
    opts.apiKey ??
    (typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined);
  const doFetch =
    opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!apiKey && !opts.fetchImpl) {
    throw new Error(
      `${label}: no ANTHROPIC_API_KEY set (and no injected fetchImpl for tests)`,
    );
  }
  if (!doFetch) {
    throw new Error(`${label}: no fetch implementation available`);
  }
  return {
    apiKey,
    doFetch,
    version: opts.version ?? DEFAULT_VERSION,
    url: opts.baseUrl ?? DEFAULT_URL,
  };
}

function toResult(
  content: string,
  stopReason: string,
  usage?: { inputTokens: number; outputTokens: number },
): ModelCallResult {
  return {
    role: "assistant",
    content,
    stopReason,
    ...(usage ? { usage } : {}),
  };
}

export function anthropicModelPerformer(
  opts: AnthropicOptions = {},
): Performer {
  const { apiKey, doFetch, version, url } = resolveConfig(opts, "anthropicModelPerformer");

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) {
      // Loud, never a silent body that 400s at the API (no-silent-failures) —
      // matches anthropicStreamingModelPerformer.
      return {
        ok: false,
        error: {
          message:
            "anthropicModelPerformer: no model id (request.model and opts.model both absent)",
        },
      };
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          // only send the key header when we actually have one (the key-less +
          // injected-fetchImpl path is test-only; don't send an empty key).
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": version,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: req.messages,
          max_tokens: req.maxTokens ?? 1024,
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            message: `anthropic request failed: HTTP ${res.status}`,
            code: String(res.status),
          },
        };
      }
      const body = (await res.json()) as AnthropicResponse;
      const result: ModelCallResult = {
        role: "assistant",
        content: (body.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        stopReason: body.stop_reason ?? "end_turn",
        ...(body.usage
          ? {
              usage: {
                inputTokens: body.usage.input_tokens,
                outputTokens: body.usage.output_tokens,
              },
            }
          : {}),
      };
      return { ok: true, value: result as unknown as Json };
    } catch (e) {
      return {
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }
  };
}

export interface AnthropicStreamingOptions extends AnthropicOptions {
  // The model id is baked in here: the harness `model_call` request carries only
  // { messages } (no model). A server resolves this from image.lock.model.id. The
  // request's own `model` (if any) still wins.
  model?: string;
  // Per text delta; a NON-JOURNALED side-channel (live UX only). Optional — a
  // buffered consumer (no stream) simply passes nothing and no deltas fire.
  onDelta?: (text: string) => void;
}

// Streaming model_call performer: sends stream:true + Accept SSE, fires onDelta
// per text delta, and returns the SAME ModelCallResult the buffered path would —
// so the journaled effect_result reconciles with join(deltas). A shim that ignores
// stream:true (non-SSE content-type) falls back to a buffered read + one delta.
export function anthropicStreamingModelPerformer(
  opts: AnthropicStreamingOptions = {},
): Performer {
  const { apiKey, doFetch, version, url } = resolveConfig(
    opts,
    "anthropicStreamingModelPerformer",
  );
  const onDelta = opts.onDelta ?? (() => {});

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) {
      // Loud, never a silent body that 400s at the API (no-silent-failures).
      return {
        ok: false,
        error: {
          message:
            "anthropicStreamingModelPerformer: no model id (request.model and opts.model both absent)",
        },
      };
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": version,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: req.messages,
          max_tokens: req.maxTokens ?? 1024,
          stream: true,
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            message: `anthropic request failed: HTTP ${res.status}`,
            code: String(res.status),
          },
        };
      }
      const ctype = res.headers?.get?.("content-type") ?? "";
      if (!ctype.startsWith("text/event-stream") || !res.body) {
        // Fallback: the endpoint ignored stream:true → buffer it like the
        // non-streaming path and emit one delta with the whole text.
        const body = (await res.json()) as AnthropicResponse;
        const content = (body.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (content) onDelta(content);
        const usage = body.usage
          ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }
          : undefined;
        return {
          ok: true,
          value: toResult(content, body.stop_reason ?? "end_turn", usage) as unknown as Json,
        };
      }
      const acc = await readAnthropicSse(res.body, onDelta);
      return {
        ok: true,
        value: toResult(acc.content, acc.stopReason, acc.usage) as unknown as Json,
      };
    } catch (e) {
      return {
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }
  };
}
