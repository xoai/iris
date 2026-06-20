// The real `tool_call` performer (spec §3.5). Replaces M2's simulated in-process
// performer: given the kernel's `tool_call` effect request (a ToolCall
// {callId,name,args}), resolve the ToolContract by name and invoke it across the
// real protocol boundary via the ToolInvoker. The engine's effect/recovery/replay
// machinery is reused verbatim — engine.ts is byte-untouched. Host-side.
import type { Performer, Outcome, Json } from "@irisrun/core";
import type { ToolRegistry } from "./contract.ts";
import type { ToolInvoker } from "./invoker.ts";

/**
 * Build a `tool_call` Performer over a registry + invoker. An unknown tool name
 * surfaces loudly as `{ok:false}` (never a silent success). The engine passes
 * the effect's `idempotencyKey` as the Performer's second argument on a recovery
 * re-perform; it is FORWARDED into `invoker.invoke(...)` so a retry-safe tool can
 * dedupe (the T7 dedupe path).
 */
export function makeToolPerformer(
  registry: ToolRegistry,
  invoker: ToolInvoker,
): Performer {
  return async (request: Json, idempotencyKey?: string): Promise<Outcome> => {
    const call = request as { callId?: string; name?: string; args?: Json };
    const name = call.name ?? "";
    const contract = registry.get(name);
    if (!contract) {
      return { ok: false, error: { message: `unknown tool: "${name}"`, code: "unknown_tool" } };
    }
    const result = await invoker.invoke(contract, call.args ?? null, idempotencyKey);
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: result.error };
  };
}
