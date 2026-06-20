// A program that performs ONE `tactic` effect (a seam consultation) then
// finishes. Mirrors model-program.ts: a terminal `phase` flag ensures a resume
// of a completed session emits NO second tactic effect (the engine has no
// terminal-state guard, so step() runs again on the done state). This is the
// minimal proof that a seam consultation IS an effect performed via the existing
// PerformerRegistry — ZERO engine change.
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  Json,
} from "@irisrun/core";

export interface TState extends Record<string, Json> {
  phase: string; // consult | decided | done
  choice: Json;
}

export const tacticProgram: Program<TState> = {
  initial: { phase: "consult", choice: null },
  reducer: (state, r: JournalRecord): TState => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok) {
        const value = p.outcome.value as { choice?: Json };
        return { ...state, choice: value.choice ?? null, phase: "decided" };
      }
      return state;
    }
    if (r.kind === "marker") {
      const m = r.payload as Marker;
      if (m.marker === "finish") return { ...state, phase: "done" };
    }
    return state;
  },
  step: (state): Action => {
    if (state.phase === "consult") {
      return {
        type: "effect",
        effectKind: "tactic",
        request: { seam: "decideNext", payload: { reason: "test" } },
      };
    }
    // decided | done → finish; never re-emits the tactic effect
    return { type: "finish", output: { choice: state.choice } };
  },
};
