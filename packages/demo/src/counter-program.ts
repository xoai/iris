// The no-model demo: a 2-step counter machine (spec §5, brief item 10). It reads
// a logical clock (effect), parks on a timer, then echoes and finishes — all
// deterministic. No model call anywhere.
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  Json,
} from "@irisrun/core";

export const TIMER_DELAY = 10;

export interface CounterState extends Record<string, Json> {
  phase: string; // start | afterClock | parked | echoed | done
  startedAt: number; // -1 until the clock effect resolves
  counter: number;
  echoed: Json; // null until the echo effect resolves
}

export const counterInitial: CounterState = {
  phase: "start",
  startedAt: -1,
  counter: 0,
  echoed: null,
};

export function counterReducer(
  state: CounterState,
  r: JournalRecord,
): CounterState {
  if (r.kind === "effect_result") {
    const p = r.payload as EffectResult;
    if (!p.outcome.ok) return state;
    if (p.effectId.startsWith("clock:")) {
      return {
        ...state,
        startedAt: p.outcome.value as number,
        counter: 1,
        phase: "afterClock",
      };
    }
    if (p.effectId.startsWith("echo:")) {
      return { ...state, echoed: p.outcome.value, counter: 2, phase: "echoed" };
    }
    return state;
  }
  if (r.kind === "marker") {
    const m = r.payload as Marker;
    if (m.marker === "wait") return { ...state, phase: "parked" };
    if (m.marker === "finish") return { ...state, phase: "done" };
  }
  return state; // intent / decision are state no-ops
}

export function counterStep(state: CounterState): Action {
  switch (state.phase) {
    case "start":
      return {
        type: "effect",
        effectKind: "clock",
        request: {},
        idempotencyKey: "clock",
      };
    case "afterClock":
      return { type: "wait", wait: { kind: "timer", at: state.startedAt + TIMER_DELAY } };
    case "parked":
      return {
        type: "effect",
        effectKind: "echo",
        request: { counter: state.counter },
        idempotencyKey: "echo",
      };
    default: // echoed | done
      return {
        type: "finish",
        output: { counter: state.counter, echoed: state.echoed },
      };
  }
}

export const counterProgram: Program<CounterState> = {
  initial: counterInitial,
  reducer: counterReducer,
  step: counterStep,
};
