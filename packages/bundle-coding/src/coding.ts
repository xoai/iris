// @iris/bundle-coding — the first domain (coding) tactic bundle. HOST-SIDE: it
// composes coding-specialized tactics on the 5 harness seams from @iris/core's
// EXPORTED primitives ([[lrn-core-exports-functions-only]]), so @iris/core stays
// byte-untouched. The assembled `codingBundle()` returns the SAME shape as core's
// `defaultBundle()` — a pure `tacticPerformer` (a Performer answering a
// {seam, payload} request with {seam, tacticId:"iris/coding", choice}) plus the
// kernel invariant caps. The journaled {seam, tacticId, choice} outcome rides the
// `tactic` effect's result value exactly like the default bundle, so the ADR-0007
// quarantine (replay folds the journaled choice, never re-invokes a tactic)
// applies to this external bundle unchanged.
//
// Pure composition over core's surface — no host/Node imports (the @iris/core
// dependency is the ONLY dependency; this package is NOT a host/transport package).
import {
  composeAssemble,
  composeDecideNext,
  composeGate,
  reactAssembleContext,
  reactDecideNext,
  windowCompaction,
  toolRepair,
  defaultInvariants,
} from "@iris/core";
import type {
  Json,
  Performer,
  Outcome,
  Invariants,
  Bundle,
  Tactic,
  GateChoice,
  DecideNext,
  Budget,
  ReadonlyHarnessView,
  ModelContext,
  ToolCall,
  ErrorInfo,
} from "@iris/core";

/** The stable id pinned into `Lock.tactics.bundle` and journaled as the tacticId. */
export const BUNDLE_ID = "iris/coding";

// The read-only / reversible tools a coding agent may run without a gate. Writes
// and shell are NOT here — they default to "ask" (HITL approval), the secure
// gate-irreversible-by-default floor for a coding workflow.
const DEFAULT_READ_ONLY_TOOLS = ["read_file", "search", "list", "grep", "glob"] as const;

export interface CodingBundleOptions {
  /** Extra read-only tools to allow-list (merged with the coding defaults). */
  readOnlyTools?: string[];
  /** shouldCompact trailing-window size (passed to windowCompaction). */
  keepLast?: number;
  /** onToolError retry cap (passed to toolRepair). */
  maxAttempts?: number;
  invariants?: { maxStepsPerTurn?: number; maxToolCalls?: number };
}

/**
 * The coding-specialized gateAction tactic: read-only / codebase-search tools are
 * a safe ALLOW; every other tool — writes (`write_file`), shell (`run_shell`),
 * and anything unknown/irreversible — is gated to "ask" (HITL). A host-side
 * factory function (not a bare object), matching core's convention.
 */
export function codingGate(readOnlyTools: string[] = []): Tactic<"gateAction"> {
  const safe = new Set<string>([...DEFAULT_READ_ONLY_TOOLS, ...readOnlyTools]);
  return {
    id: "iris/coding-gate",
    seam: "gateAction",
    decide: ({ call }): GateChoice => (safe.has(call.name) ? "allow" : "ask"),
  };
}

/**
 * The coding bundle's decideNext: it DELEGATES verbatim to the proven ReAct
 * tool-loop (continue while the model still requests tools, finish when it stops) —
 * which is the CORRECT policy for a coding tool-loop agent, so there is nothing to
 * "tune" today. The coding-specific behavior lives in `codingGate` (the
 * read-only-allow / write-gate split). This is kept as a DISTINCT factory only so a
 * future coding heuristic (e.g. a max-edit budget) can layer in here without
 * touching core or the bundle's call sites — it is a pass-through for now.
 */
export function codingDecideNext(): Tactic<"decideNext"> {
  const react = reactDecideNext();
  return {
    id: "iris/coding-decide",
    seam: "decideNext",
    decide: ({ state }): DecideNext => react.decide({ state }),
  };
}

/**
 * Assemble the coding bundle: the SAME structure as core's `defaultBundle`, with
 * the coding-specialized gate + decideNext and the reused window-compaction /
 * tool-repair tactics, returning `{ tacticPerformer, invariants }`.
 */
export function codingBundle(opts: CodingBundleOptions = {}): Bundle {
  const assembleChain = [reactAssembleContext()];
  const decideChain = [codingDecideNext()];
  const gateChain = [codingGate(opts.readOnlyTools)];
  const compact = windowCompaction(opts.keepLast);
  const repair = toolRepair(opts.maxAttempts);

  const tacticPerformer: Performer = async (request: Json): Promise<Outcome> => {
    const req = request as { seam?: string; payload?: Json };
    const seam = req.seam ?? "";
    const payload = req.payload ?? null;
    let choice: Json;
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        choice = composeAssemble(assembleChain, pl.state, pl.ctx);
        break;
      }
      case "shouldCompact": {
        const pl = payload as { ctx: ModelContext; budget: Budget };
        choice = compact.decide(pl);
        break;
      }
      case "gateAction": {
        const pl = payload as { call: ToolCall };
        choice = composeGate(gateChain, pl.call);
        break;
      }
      case "onToolError": {
        const pl = payload as { call: ToolCall; error: ErrorInfo; attempt: number };
        choice = repair.decide(pl);
        break;
      }
      case "decideNext": {
        const pl = payload as { state: ReadonlyHarnessView };
        choice = composeDecideNext(decideChain, pl.state);
        break;
      }
      default:
        return { ok: false, error: { message: `codingBundle: unknown seam '${seam}'` } };
    }
    return { ok: true, value: { seam, tacticId: BUNDLE_ID, choice } };
  };

  const invariants: Invariants = defaultInvariants(opts.invariants);
  return { tacticPerformer, invariants };
}
