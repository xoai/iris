// A no-key STREAMING model performer (serve-streaming Task 6). It echoes the last
// user message as the assistant reply, firing onDelta in word-chunks so an
// `iris serve` SSE/WS stream is demonstrable WITHOUT an ANTHROPIC_API_KEY — the
// turnkey no-key path. It ignores `request.model` (independent of the Anthropic
// contract). Pure: no env, no network → also a deterministic streaming fixture.
import type { Performer, Json, Outcome } from "@iris/core";
import type { ModelCallResult } from "@iris/provider-anthropic";

export function echoStreamingPerformer(onDelta?: (text: string) => void): Performer {
  return async (request: Json): Promise<Outcome> => {
    const req = request as { messages?: { role?: string; content?: string }[] };
    const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === "user");
    const reply = `echo: ${lastUser?.content ?? ""}`.trimEnd();
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i++) onDelta?.(i === 0 ? words[i] : ` ${words[i]}`);
    const result: ModelCallResult = { role: "assistant", content: reply, stopReason: "end_turn" };
    return { ok: true, value: result as unknown as Json };
  };
}
