// A small event-sourced reducer used by replay/assertion tests. State is plain
// Json (no optional fields) so it round-trips cleanly.
import type {
  JournalRecord,
  EffectResult,
  Decision,
  Marker,
  Json,
} from "@iris/core";

export interface SumState extends Record<string, Json> {
  sum: number;
  steps: string[];
  finished: boolean;
}

export const sumInitial: SumState = { sum: 0, steps: [], finished: false };

export function sumReducer(state: SumState, r: JournalRecord): SumState {
  switch (r.kind) {
    case "effect_result": {
      const p = r.payload as EffectResult;
      if (p.outcome.ok && typeof p.outcome.value === "number") {
        return {
          ...state,
          sum: state.sum + p.outcome.value,
          steps: [...state.steps, `+${p.outcome.value}`],
        };
      }
      return state;
    }
    case "decision": {
      const d = r.payload as Decision;
      return { ...state, steps: [...state.steps, `decision:${d.seam}`] };
    }
    case "marker": {
      const m = r.payload as Marker;
      if (m.marker === "finish") return { ...state, finished: true };
      return state;
    }
    case "effect_intent":
      return state; // contract: intent is a state no-op
  }
}
