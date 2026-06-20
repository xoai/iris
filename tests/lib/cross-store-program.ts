// A counted-echo program that does N echo effects, parks on a timer, then
// finishes on resume (terminal-flag pattern, cf. parkProgram). Used by the
// cross-store test: with a low snapshotThreshold, the N effects force a
// snapshot+truncate on store A before the park.
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  Json,
} from "@irisrun/core";

export interface XState extends Record<string, Json> {
  phase: string; // running | parked | done
  count: number;
}

export function makeCrossProgram(n: number): Program<XState> {
  return {
    initial: { phase: "running", count: 0 },
    reducer: (state, r: JournalRecord): XState => {
      if (r.kind === "effect_result") {
        const p = r.payload as EffectResult;
        return p.outcome.ok ? { ...state, count: state.count + 1 } : state;
      }
      if (r.kind === "marker") {
        const m = r.payload as Marker;
        if (m.marker === "wait") return { ...state, phase: "parked" };
        if (m.marker === "finish") return { ...state, phase: "done" };
      }
      return state;
    },
    step: (state): Action => {
      if (state.phase === "parked" || state.phase === "done") {
        return { type: "finish", output: { count: state.count } };
      }
      if (state.count < n) {
        return {
          type: "effect",
          effectKind: "echo",
          request: { i: state.count },
          idempotencyKey: `e${state.count}`,
        };
      }
      return { type: "wait", wait: { kind: "timer", at: 100 } };
    },
  };
}
