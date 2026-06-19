// Deterministic fake model performer — the test default for model_call (no
// network, no key, no cost). Reply is derived from the last user message.
import type { Performer, Json, Outcome } from "@iris/core";

export interface CallCounter {
  n: number;
}

export function makeFakeModel(counter?: CallCounter): Performer {
  return async (request: Json): Promise<Outcome> => {
    if (counter) counter.n += 1;
    const req = request as { messages?: Array<{ role: string; content: string }> };
    const lastUser = [...(req.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    return {
      ok: true,
      value: {
        role: "assistant",
        content: `echo:${lastUser?.content ?? ""}`,
        stopReason: "end_turn",
      },
    };
  };
}

// A model that returns a scripted sequence of responses by call index (clamped to
// the last). Lets a multi-step loop test drive "tool calls first, end_turn next".
export function makeScriptedModel(responses: Json[], counter?: CallCounter): Performer {
  let i = 0;
  return async (): Promise<Outcome> => {
    if (counter) counter.n += 1;
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, value };
  };
}
