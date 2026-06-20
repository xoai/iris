// Kernel-enforced invariants. Two DISTINCT mechanisms (do not conflate):
//
//  - Remit isolation = TYPE-enforced. The narrow seam signatures (seams.ts) mean a
//    tactic physically cannot reach another seam's concern, and no seam has any cap
//    input/output at all — so a tactic literally cannot read or raise a cap. That
//    is a compile-time guarantee, tested with @ts-expect-error.
//
//  - Cap-tightening = RUNTIME kernel override. Caps live ONLY here; the kernel
//    enforces them in the reducer by forcing the loop to `done` when a journaled
//    counter exceeds a cap, regardless of what a tactic returned. The counters live
//    in HarnessState (journaled, incremented in the reducer), so the override is
//    deterministic across replay.
//
// Caps the kernel ACTUALLY enforces as halts: `maxStepsPerTurn` (every effect is
// one step, so this bounds EVERY runaway — assemble loops AND tool-error retry
// storms) and the optional `maxToolCalls`. Token budgeting is a separate concern:
// it drives compaction via `HarnessConfig.budget`, NOT a halt — so it is not an
// Invariant here (a cap that isn't enforced would be a lie). `gateIrreversibleByDefault`
// and `egressDefault` are pinned to single literal values by the type — config may
// only TIGHTEN, never loosen them. (Real egress enforcement lands later with a
// network boundary; for now it is a constant/type-level default.)
import type { HarnessState, Phase } from "./kernel.ts";

export interface Invariants {
  // Hard cap on loop steps (1 step per effect) — bounds every runaway. A "turn"
  // is the whole loop from initial state to `finish`; in this slice that spans the entire
  // session, INCLUDING park/resume cycles (a turn does NOT end at a park), so
  // `steps` is not reset across resumes — which is exactly what backstops an
  // unbounded park/resume loop. When real multi-turn sessions land, a new
  // turn boundary MUST reset `steps`, or turn N+1 would inherit turn N's count.
  maxStepsPerTurn: number;
  maxToolCalls?: number; // optional hard cap on successful tool calls
  gateIrreversibleByDefault: true; // pinned: cannot be loosened to false
  egressDefault: "deny-all"; // pinned: no runtime network yet (enforced for real later)
}

export function defaultInvariants(
  overrides: { maxStepsPerTurn?: number; maxToolCalls?: number } = {},
): Invariants {
  const inv: Invariants = {
    maxStepsPerTurn: overrides.maxStepsPerTurn ?? 64,
    gateIrreversibleByDefault: true,
    egressDefault: "deny-all",
  };
  if (overrides.maxToolCalls !== undefined) inv.maxToolCalls = overrides.maxToolCalls;
  return inv;
}

// Pure: returns a forced terminal phase when a journaled counter breaches a cap,
// else null. Reads only journaled state, so the override replays deterministically.
export function enforceInvariants(state: HarnessState, inv: Invariants): Phase | null {
  if (state.steps > inv.maxStepsPerTurn) return "done";
  if (inv.maxToolCalls !== undefined && state.toolCalls > inv.maxToolCalls) return "done";
  return null;
}
