// Direct OpenAI Chat Completions adapter — a model_call performer behind the same
// model port as @iris/provider-anthropic. Host-side; uses the built-in `fetch`
// (zero deps); `fetch` is injectable so unit tests run with no network/key. A
// missing key is a CONSTRUCTION-time config error (loud) — never a mid-turn
// laundered failure. Mirrors packages/provider-anthropic/src/anthropic.ts exactly,
// including the buffered/streaming SYMMETRY (req.model ?? opts.model + a loud
// {ok:false} guard) — see the Iris memory lesson on the buffered Anthropic variant
// that once shipped without it and 400'd a standalone caller.
import type { Performer, Json, Outcome } from "@iris/core";
import type { ModelCallRequest, ModelCallResult, ModelMessage } from "./types.ts";
import { readOpenAiSse } from "./sse.ts";

export interface OpenAiOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  // A fallback model id when the request carries none. The harness `model_call`
  // request is `{ messages }` (no model), so a STANDALONE caller (e.g. an edge
  // worker without wrapModelForImage) must bake the model in here. The request's
  // own `model` still wins. (Symmetric with the streaming variant.)
  model?: string;
}

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ResolvedConfig {
  apiKey: string | undefined;
  doFetch: typeof fetch;
  url: string;
}

// Shared config resolution + CONSTRUCTION-time validation: a registered performer
// that threw at call time would be caught by the engine and laundered to
// {ok:false}, so these errors fire at construction. Both performers go through
// this — identical posture to the Anthropic adapter.
function resolveConfig(opts: OpenAiOptions, label: string): ResolvedConfig {
  const apiKey =
    opts.apiKey ??
    (typeof process !== "undefined" ? process.env.OPENAI_API_KEY : undefined);
  const doFetch =
    opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!apiKey && !opts.fetchImpl) {
    throw new Error(
      `${label}: no OPENAI_API_KEY set (and no injected fetchImpl for tests)`,
    );
  }
  if (!doFetch) {
    throw new Error(`${label}: no fetch implementation available`);
  }
  return {
    apiKey,
    doFetch,
    url: opts.baseUrl ?? DEFAULT_URL,
  };
}

// Map the port request to OpenAI Chat Completions `messages`. OpenAI has no
// top-level `system` field — the system prompt is a leading `system` message.
function buildMessages(req: ModelCallRequest): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  if (req.system !== undefined) {
    // Cast: OpenAI accepts a "system" role; the port's ModelMessage union is
    // user|assistant, so we widen at this boundary only.
    msgs.push({ role: "system", content: req.system } as unknown as ModelMessage);
  }
  for (const m of req.messages) msgs.push(m);
  return msgs;
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  // only send the auth header when we actually have a key (the key-less +
  // injected-fetchImpl path is test-only; don't send an empty Bearer).
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
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

export function openaiModelPerformer(opts: OpenAiOptions = {}): Performer {
  const { apiKey, doFetch, url } = resolveConfig(opts, "openaiModelPerformer");

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) {
      // Loud, never a silent body that 400s at the API (no-silent-failures) —
      // symmetric with the streaming performer.
      return {
        ok: false,
        error: {
          message:
            "openaiModelPerformer: no model id (request.model and opts.model both absent)",
        },
      };
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          model,
          messages: buildMessages(req),
          max_tokens: req.maxTokens ?? 1024,
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            message: `openai request failed: HTTP ${res.status}`,
            code: String(res.status),
          },
        };
      }
      const body = (await res.json()) as OpenAiResponse;
      const choice = body.choices?.[0];
      const result: ModelCallResult = {
        role: "assistant",
        content: choice?.message?.content ?? "",
        stopReason: choice?.finish_reason ?? "stop",
        ...(body.usage
          ? {
              usage: {
                inputTokens: body.usage.prompt_tokens ?? 0,
                outputTokens: body.usage.completion_tokens ?? 0,
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

export interface OpenAiStreamingOptions extends OpenAiOptions {
  // Per content delta; a NON-JOURNALED side-channel (live UX only). Optional — a
  // buffered consumer (no stream) simply passes nothing and no deltas fire.
  onDelta?: (text: string) => void;
}

// Streaming model_call performer: sends stream:true + Accept SSE + usage opt-in,
// fires onDelta per content delta, and returns the SAME ModelCallResult the
// buffered path would — so the journaled effect_result reconciles with
// join(deltas). A shim that ignores stream:true (non-SSE content-type) falls back
// to a buffered read + one delta.
export function openaiStreamingModelPerformer(
  opts: OpenAiStreamingOptions = {},
): Performer {
  const { apiKey, doFetch, url } = resolveConfig(opts, "openaiStreamingModelPerformer");
  const onDelta = opts.onDelta ?? ((): void => {});

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) {
      return {
        ok: false,
        error: {
          message:
            "openaiStreamingModelPerformer: no model id (request.model and opts.model both absent)",
        },
      };
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { ...authHeaders(apiKey), accept: "text/event-stream" },
        body: JSON.stringify({
          model,
          messages: buildMessages(req),
          max_tokens: req.maxTokens ?? 1024,
          stream: true,
          // ask for a trailing usage chunk so the streamed result carries usage too
          stream_options: { include_usage: true },
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            message: `openai request failed: HTTP ${res.status}`,
            code: String(res.status),
          },
        };
      }
      const ctype = res.headers?.get?.("content-type") ?? "";
      if (!ctype.startsWith("text/event-stream") || !res.body) {
        // Fallback: the endpoint ignored stream:true → buffer it like the
        // non-streaming path and emit one delta with the whole text.
        const body = (await res.json()) as OpenAiResponse;
        const choice = body.choices?.[0];
        const content = choice?.message?.content ?? "";
        if (content) onDelta(content);
        const usage = body.usage
          ? {
              inputTokens: body.usage.prompt_tokens ?? 0,
              outputTokens: body.usage.completion_tokens ?? 0,
            }
          : undefined;
        return {
          ok: true,
          value: toResult(content, choice?.finish_reason ?? "stop", usage) as unknown as Json,
        };
      }
      const acc = await readOpenAiSse(res.body, onDelta);
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
