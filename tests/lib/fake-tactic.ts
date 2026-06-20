// Deterministic fake `tactic` performer — the test default for a seam
// consultation. A seam consultation IS an effect (effectKind "tactic") performed
// via the existing PerformerRegistry, exactly like model_call: the performer runs
// the seam's tactic chain and returns the decision as the effect result VALUE
// { seam, tacticId, choice }. Replay never calls it (ADR-0007 quarantine), which
// is what the tactic-swap proof (C4) relies on.
import type { Performer, Json, Outcome } from "@irisrun/core";

// Structural counter (matches fake-model.ts's CallCounter by shape). Lets a test
// assert the performer ran exactly once live and zero times on replay/resume.
export interface CallCounter {
  n: number;
}

// `choice` is the seam decision this fake returns (e.g. "finish" for decideNext,
// "allow" for gateAction). Deterministic: same request → same result.
export function makeFakeTactic(
  choice: Json,
  tacticId = "fake",
  counter?: CallCounter,
): Performer {
  return async (request: Json): Promise<Outcome> => {
    if (counter) counter.n += 1;
    const req = request as { seam?: string };
    return {
      ok: true,
      value: { seam: req.seam ?? "", tacticId, choice },
    };
  };
}

// Multi-seam fake tactic performer: maps a seam name → the choice it returns. The
// kernel consults several seams per turn (assembleContext / shouldCompact /
// decideNext / gateAction / onToolError), so a kernel test scripts each one. An
// unscripted seam yields a loud {ok:false}. Stands in for the real defaultBundle
// tactic performer (Task 10) in earlier kernel tests.
export function makeFakeTacticBySeam(
  bySeam: Record<string, Json>,
  counter?: CallCounter,
): Performer {
  return async (request: Json): Promise<Outcome> => {
    if (counter) counter.n += 1;
    const req = request as { seam?: string };
    const seam = req.seam ?? "";
    if (!(seam in bySeam)) {
      return { ok: false, error: { message: `no fake tactic scripted for seam '${seam}'` } };
    }
    return { ok: true, value: { seam, tacticId: "fake", choice: bySeam[seam] } };
  };
}

// Tactic performer that delegates each seam to a test-provided decide function
// (typically running real tactics through the compose* functions). Stands in for
// the real defaultBundle tactic performer (Task 10) for kernel tests that need
// the choice computed from the payload (e.g. react's continue-vs-finish).
export function makeTacticRouter(
  decide: (seam: string, payload: Json) => Json,
  counter?: CallCounter,
): Performer {
  return async (request: Json): Promise<Outcome> => {
    if (counter) counter.n += 1;
    const req = request as { seam?: string; payload?: Json };
    const seam = req.seam ?? "";
    return { ok: true, value: { seam, tacticId: "router", choice: decide(seam, req.payload ?? null) } };
  };
}
