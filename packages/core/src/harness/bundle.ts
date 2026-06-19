// The default tactic bundle (spec §3.7): react (assembleContext + decideNext),
// window-compaction (shouldCompact), tool-repair (onToolError), and
// approve-irreversible (gateAction). `defaultBundle()` returns a PURE tactic
// performer — a single function that, given a `{seam, payload}` request, runs that
// seam's composed chain and returns `{seam, tacticId, choice}` — plus the kernel
// invariant caps. The performer is built here in core but WIRED into the
// PerformerRegistry by the runner/host (core never injects performers itself).
//
// Pure: imports stay within core (A1 / C7).
import type { Json } from "../json.ts";
import type { Performer, Outcome } from "../program.ts";
import type { Budget, ReadonlyHarnessView, ModelContext, ToolCall, ErrorInfo } from "./seams.ts";
import { composeAssemble, composeDecideNext, composeGate } from "./seams.ts";
import { reactAssembleContext, reactDecideNext } from "./tactics/react.ts";
import { windowCompaction } from "./tactics/window-compaction.ts";
import { toolRepair } from "./tactics/tool-repair.ts";
import { approveIrreversible } from "./tactics/approve-irreversible.ts";
import type { Invariants } from "./invariants.ts";
import { defaultInvariants } from "./invariants.ts";

export interface DefaultBundleOptions {
  safeTools?: string[];
  keepLast?: number;
  maxAttempts?: number;
  invariants?: { maxStepsPerTurn?: number; maxToolCalls?: number };
}

export interface Bundle {
  tacticPerformer: Performer;
  invariants: Invariants;
}

export function defaultBundle(opts: DefaultBundleOptions = {}): Bundle {
  const assembleChain = [reactAssembleContext()];
  const decideChain = [reactDecideNext()];
  const gateChain = [approveIrreversible(opts.safeTools)];
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
        return { ok: false, error: { message: `defaultBundle: unknown seam '${seam}'` } };
    }
    return { ok: true, value: { seam, tacticId: "default-bundle", choice } };
  };

  return { tacticPerformer, invariants: defaultInvariants(opts.invariants) };
}
