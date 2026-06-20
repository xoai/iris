// The tool-repair default tactic: bounded retry + schema-repair on the
// onToolError seam. If the tool suggested a structured `fix`, apply it once as a
// patch (repair); otherwise retry transient failures up to `maxAttempts`, then give
// up. `attempt` is the failure count so far for the current call (the kernel
// increments it), so the cap is what prevents an infinite retry loop.
//
// Pure decider — no host imports (A1 / C7).
import type { Tactic } from "../seams.ts";

export function toolRepair(maxAttempts = 2): Tactic<"onToolError"> {
  return {
    id: "iris/tool-repair",
    seam: "onToolError",
    decide: ({ error, attempt }) => {
      if (attempt >= maxAttempts) return { action: "giveUp" };
      if (error.fix !== undefined) return { action: "repair", patch: error.fix };
      return { action: "retry" };
    },
  };
}
