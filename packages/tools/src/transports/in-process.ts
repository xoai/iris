// In-process transport (spec §3.3): calls a registered JS function directly —
// trusted, same-language, fastest; the `tool_locality:"in-process"` case. The
// contract's location ("inproc://<id>") selects the registered fn. Host-side.
import type { Json } from "@iris/core";
import type { Transport } from "../invoker.ts";
import { locationHandle, messageOf, toolFailure } from "../invoker.ts";

export type InProcessFn = (
  input: Json,
  idempotencyKey?: string,
) => Promise<Json> | Json;

/**
 * Build an in-process transport over a map of `id → fn`. A thrown error from a
 * fn is mapped to `{ok:false}` (never propagated raw); an unregistered id fails
 * loudly with code `unknown_tool`.
 */
export function makeInProcessTransport(
  fns: Record<string, InProcessFn>,
): Transport {
  return {
    async invoke(contract, input, idempotencyKey) {
      const id = locationHandle(contract.location, "inproc");
      const fn = fns[id];
      if (!fn) {
        return toolFailure(
          `in-process tool not registered: "${id}"`,
          "unknown_tool",
        );
      }
      try {
        const value = await fn(input, idempotencyKey);
        return { ok: true, value };
      } catch (e) {
        return toolFailure(messageOf(e), "tool_threw");
      }
    },
  };
}
