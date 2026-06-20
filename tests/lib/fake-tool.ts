// Simulated in-process `tool_call` performer (real protocol-boundary tools +
// sandbox come later). The kernel's `tool_exec` phase emits a `tool_call`
// effect whose request is a tool call `{ name, args }`; this fixture runs the
// scripted outcome so harness tests can drive success / error / repair paths
// deterministically. `callIndex` (0-based, per performer instance) lets a test
// sequence outcomes — e.g. fail on the first attempt, succeed on the retry.
import type { Performer, Json, Outcome } from "@irisrun/core";

export interface ToolCallLog {
  calls: Array<{ name: string; args: Json }>;
}

export type ToolScript = (
  call: { name: string; args: Json },
  callIndex: number,
) => Outcome;

export function makeFakeTool(script: ToolScript, log?: ToolCallLog): Performer {
  let callIndex = 0;
  return async (request: Json): Promise<Outcome> => {
    const raw = request as { name?: string; args?: Json };
    const call = { name: raw.name ?? "", args: raw.args ?? null };
    if (log) log.calls.push(call);
    return script(call, callIndex++);
  };
}
