// Shared building blocks for model_call record-replay FIDELITY tests (roadmap
// v0.2 P2 #7). Used keyless (model-call-replay-fidelity.test.ts) and by the
// env-gated live tier (provider-live-conformance.test.ts).
import type {
  Program,
  Action,
  JournalRecord,
  EffectResult,
  Marker,
  EngineDeps,
  Json,
  Performer,
  Outcome,
} from "@irisrun/core";
import { runTurn } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./mem-store.ts";

// model_call → wait(timer) → finish. Parking between the effect and finish forces
// a RESUME to re-enter the step loop with the effect already journaled — the case
// a "run-to-finish then replay" check cannot exercise.
export interface FState extends Record<string, Json> {
  phase: string; // ask | answered | parked | done
  reply: Json;
}
export const fidelityProgram: Program<FState> = {
  initial: { phase: "ask", reply: null },
  reducer: (state, r: JournalRecord): FState => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok) return { ...state, reply: p.outcome.value, phase: "answered" };
      return state;
    }
    if (r.kind === "marker") {
      const m = r.payload as Marker;
      if (m.marker === "wait") return { ...state, phase: "parked" };
      if (m.marker === "finish") return { ...state, phase: "done" };
    }
    return state;
  },
  step: (state): Action => {
    if (state.phase === "ask") {
      return { type: "effect", effectKind: "model_call", request: { model: "fake", messages: [{ role: "user", content: "hi" }] } };
    }
    if (state.phase === "answered") return { type: "wait", wait: { kind: "timer", at: 100 } };
    return { type: "finish", output: { reply: state.reply } };
  },
};

function deps(store: MemoryStateStore, performer: Performer): EngineDeps<FState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: fidelityProgram,
    performers: { model_call: performer },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

export interface FidelityRun {
  parkedOk: boolean; // the original turn parked after the model_call
  finishedOk: boolean; // the resume finished
  poisonFired: number; // times the resume performer was (wrongly) invoked — must be 0
  recordedReply: Json; // the value the resumed/finished session carries
}

/**
 * Drive the fidelity protocol: perform a model_call with `livePerformer` and park;
 * then resume on a FRESH engine over the same store whose model_call performer is a
 * POISON PILL. A correct engine reads the journaled effect_result and never invokes
 * the performer on resume. Returns observables for the caller to assert.
 */
export async function recordThenResumeWithPoison(livePerformer: Performer): Promise<FidelityRun> {
  const store = new MemoryStateStore();
  const t1 = await runTurn(deps(store, livePerformer), "s");
  const parkedOk = t1.status === "parked";

  let poisonFired = 0;
  const poison: Performer = async (): Promise<Outcome> => {
    poisonFired += 1;
    throw new Error("model_call performer must NOT be re-invoked on replay/resume");
  };
  const t2 = await runTurn(deps(store, poison), "s");
  const finishedOk = t2.status === "finished";
  const recordedReply =
    t2.status === "finished" ? (t2.output as { reply: Json }).reply : null;
  return { parkedOk, finishedOk, poisonFired, recordedReply };
}
