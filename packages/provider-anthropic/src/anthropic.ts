// Direct Anthropic Messages adapter (spec §3.2, §4). Host-side; uses the
// built-in `fetch` (zero deps); `fetch` is injectable so unit tests run with no
// network/key. A missing key is a CONSTRUCTION-time config error (loud) — never
// a mid-turn laundered failure.
import type { Performer, Json, Outcome } from "@iris/core";
import type { ModelCallRequest, ModelCallResult } from "./types.ts";

export interface AnthropicOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  version?: string;
  baseUrl?: string;
}

const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export function anthropicModelPerformer(
  opts: AnthropicOptions = {},
): Performer {
  const apiKey =
    opts.apiKey ??
    (typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined);
  const doFetch =
    opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);

  // Config errors fail at CONSTRUCTION (spec §3.2): a registered performer that
  // threw at call time would be caught by the engine and laundered to {ok:false}.
  if (!apiKey && !opts.fetchImpl) {
    throw new Error(
      "anthropicModelPerformer: no ANTHROPIC_API_KEY set (and no injected fetchImpl for tests)",
    );
  }
  if (!doFetch) {
    throw new Error("anthropicModelPerformer: no fetch implementation available");
  }

  const version = opts.version ?? DEFAULT_VERSION;
  const url = opts.baseUrl ?? DEFAULT_URL;

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
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
          model: req.model,
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
