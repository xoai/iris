// window-compaction (spec §3.7): when a token budget is exceeded, compact the
// context by keeping a trailing window of the most recent messages. The decision
// IS the compacted context (the shouldCompact tactic effect's result value), so
// the kernel folds it into HarnessState.ctx and replay reproduces it exactly
// without ever re-running the compactor. Returns `false` when within budget.
//
// Pure decider — no host imports (A1 / C7).
import type { Tactic, ModelContext } from "../seams.ts";

export function windowCompaction(keepLast = 6): Tactic<"shouldCompact"> {
  return {
    id: "iris/window-compaction",
    seam: "shouldCompact",
    decide: ({ ctx, budget }): false | ModelContext => {
      const limit = budget.tokens;
      const used = ctx.tokens ?? ctx.messages.length;
      if (limit === undefined || used <= limit) return false;
      const kept = ctx.messages.slice(-keepLast);
      return { messages: kept, tokens: kept.length };
    },
  };
}
