// A program that performs ONE model_call effect then finishes. Terminal flag
// (phase) ensures a resume of a completed session emits NO model_call (spec B1/F1:
// the engine has no terminal-state guard, so step() runs again on the done state).
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  Json,
} from "@irisrun/core";

export interface MState extends Record<string, Json> {
  phase: string; // ask | answered | done
  reply: Json;
}

export const modelProgram: Program<MState> = {
  initial: { phase: "ask", reply: null },
  reducer: (state, r: JournalRecord): MState => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok) return { ...state, reply: p.outcome.value, phase: "answered" };
      return state;
    }
    if (r.kind === "marker") {
      const m = r.payload as Marker;
      if (m.marker === "finish") return { ...state, phase: "done" };
    }
    return state;
  },
  step: (state): Action => {
    if (state.phase === "ask") {
      return {
        type: "effect",
        effectKind: "model_call",
        request: { model: "fake", messages: [{ role: "user", content: "hi" }] },
      };
    }
    // answered | done → finish; never re-emits the model_call
    return { type: "finish", output: { reply: state.reply } };
  },
};
