// approve-irreversible (spec §3.7): the gateAction tactic that realizes the
// gate-irreversible-by-default floor. Known safe (read-only / reversible) tools
// are allowed; everything else — irreversible or unknown — defaults to "ask".
//
// Pure decider — no host imports (A1 / C7).
import type { Tactic } from "../seams.ts";

export function approveIrreversible(safeTools: string[] = []): Tactic<"gateAction"> {
  const safe = new Set(safeTools);
  return {
    id: "iris/approve-irreversible",
    seam: "gateAction",
    decide: ({ call }) => (safe.has(call.name) ? "allow" : "ask"),
  };
}
