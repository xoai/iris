// Shared programs + performers for engine tests.
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  PerformerRegistry,
  Json,
} from "@irisrun/core";
import { TestClock } from "./mem-store.ts";

export function makePerformers(clock: TestClock): PerformerRegistry {
  return {
    clock: async () => ({ ok: true, value: clock.now() }),
    echo: async (request: Json) => ({ ok: true, value: request }),
  };
}

// --- addProgram: two echo effects then finish (no park) — for 10a ---
export interface AddState extends Record<string, Json> {
  total: number;
  count: number;
}
export const addInitial: AddState = { total: 0, count: 0 };

export function addReducer(state: AddState, r: JournalRecord): AddState {
  if (r.kind === "effect_result") {
    const p = r.payload as EffectResult;
    if (p.outcome.ok && typeof p.outcome.value === "number") {
      return { total: state.total + p.outcome.value, count: state.count + 1 };
    }
  }
  return state;
}

// n echo(+1) effects then finish — for snapshot tests (multiple snapshots).
export function makeCountProgram(n: number): Program<AddState> {
  return {
    initial: { total: 0, count: 0 },
    reducer: addReducer,
    step: (state): Action =>
      state.count < n
        ? {
            type: "effect",
            effectKind: "echo",
            request: 1,
            idempotencyKey: `k${state.count}`,
          }
        : { type: "finish", output: { total: state.total } },
  };
}
function addStep(state: AddState): Action {
  if (state.count === 0) {
    return { type: "effect", effectKind: "echo", request: 3, idempotencyKey: "k0" };
  }
  if (state.count === 1) {
    return { type: "effect", effectKind: "echo", request: 4, idempotencyKey: "k1" };
  }
  return { type: "finish", output: { total: state.total } };
}
export const addProgram: Program<AddState> = {
  initial: addInitial,
  reducer: addReducer,
  step: addStep,
};

// --- parkProgram: echo effect → wait(timer) → finish — for 10b ---
export interface ParkState extends Record<string, Json> {
  phase: string;
  v: number;
}
export const parkInitial: ParkState = { phase: "start", v: 0 };

function parkReducer(state: ParkState, r: JournalRecord): ParkState {
  if (r.kind === "effect_result") {
    const p = r.payload as EffectResult;
    if (p.outcome.ok && typeof p.outcome.value === "number") {
      return { ...state, v: p.outcome.value, phase: "afterEffect" };
    }
    return state;
  }
  if (r.kind === "marker") {
    const m = r.payload as Marker;
    if (m.marker === "wait") return { ...state, phase: "parked" };
    if (m.marker === "finish") return { ...state, phase: "done" };
  }
  return state;
}
function parkStep(state: ParkState): Action {
  if (state.phase === "start") {
    return { type: "effect", effectKind: "echo", request: 42, idempotencyKey: "e0" };
  }
  if (state.phase === "afterEffect" || state.phase === "parked") {
    // first turn parks; after resume, phase is "parked" → finish
    if (state.phase === "afterEffect") {
      return { type: "wait", wait: { kind: "timer", at: 100 } };
    }
    return { type: "finish", output: { v: state.v } };
  }
  return { type: "finish", output: { v: state.v } };
}
export const parkProgram: Program<ParkState> = {
  initial: parkInitial,
  reducer: parkReducer,
  step: parkStep,
};
