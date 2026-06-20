// scheduleProgram (P2-9, spec §5.1): a recurring job as a pure, durable Program. Each cycle
// reads the logical clock (a journaled `clock` effect), runs ONE job effect, and parks on a
// durable timer at `now + intervalTicks`; on the next wake it loops. Cadence derives ONLY
// from journaled clock results (never `record.ts`), so the whole schedule replays
// identically. `maxRuns` bounds the session (and tests). Pure — no I/O, no clock/RNG reads.
import type { Program, Action, JournalRecord, EffectResult, Marker, Json, EffectKind } from "@iris/core";

// The per-tick job: one effect run each cycle. Its performer is supplied by the host
// (e.g. `echo`, `clock`, a `tool_call`, or a `subagent` spawn — see the composition test).
//
// COMPOSITION NOTE (subagent job): `request` is FIXED across cycles, so a `subagent` job
// whose request carries a constant `callId` delegates to the SAME deterministic child
// (`childSessionId(parent, callId)`) every cycle — established on the first run and replayed
// (not re-executed) on later runs. That is the intended durable behavior. A distinct child
// PER cycle would require a cycle-varying callId; since the job request is static here,
// that is deferred (it would need the journaled run count threaded into the request).
export interface ScheduleJob {
  effectKind: EffectKind;
  request: Json;
  retrySafe?: boolean;
  idempotencyKey?: string;
}

export interface ScheduleConfig {
  intervalTicks: number; // logical-time units between runs (fixed cadence; integer > 0)
  maxRuns: number; // finish after this many job runs (integer > 0)
  job: ScheduleJob;
}

export type SchedulePhase = "read_clock" | "run_job" | "park" | "done";

export interface ScheduleState extends Record<string, Json> {
  phase: SchedulePhase;
  runs: number; // completed job runs
  now: number; // last clock reading
  nextAt: number; // next wake time = now + intervalTicks
  lastJob: Json; // last job effect result value, or { error } on a failed job (audit)
}

function validate(config: ScheduleConfig): void {
  if (!Number.isInteger(config.intervalTicks) || config.intervalTicks <= 0) {
    throw new Error(`scheduleProgram: intervalTicks must be a positive integer, got ${String(config.intervalTicks)}`);
  }
  if (!Number.isInteger(config.maxRuns) || config.maxRuns <= 0) {
    throw new Error(`scheduleProgram: maxRuns must be a positive integer, got ${String(config.maxRuns)}`);
  }
  if (config.job === null || typeof config.job !== "object" || typeof config.job.effectKind !== "string") {
    throw new Error("scheduleProgram: job must be { effectKind, request } with a string effectKind");
  }
}

export function scheduleProgram(config: ScheduleConfig): Program<ScheduleState> {
  validate(config);
  const { intervalTicks, maxRuns, job } = config;

  return {
    initial: { phase: "read_clock", runs: 0, now: 0, nextAt: 0, lastJob: null },

    reducer(state: ScheduleState, r: JournalRecord): ScheduleState {
      if (r.kind === "effect_result") {
        const result = r.payload as EffectResult;
        // Fold by PHASE (not effectId), so a job whose effectKind is itself "clock" does
        // not alias the cadence read.
        if (state.phase === "read_clock") {
          // The clock read drives cadence. A clock performer is trivial and should not
          // fail; if it ever does, keep the prior `now` rather than throwing (this is a
          // pure reducer — it must never throw on a journaled record).
          const now = result.outcome.ok ? (result.outcome.value as number) : state.now;
          return { ...state, now, nextAt: now + intervalTicks, phase: "run_job" };
        }
        if (state.phase === "run_job") {
          const lastJob: Json = result.outcome.ok
            ? result.outcome.value
            : { error: result.outcome.error };
          const runs = state.runs + 1;
          return { ...state, lastJob, runs, phase: runs >= maxRuns ? "done" : "park" };
        }
        return state;
      }
      if (r.kind === "marker") {
        const m = r.payload as Marker;
        if (m.marker === "finish") return { ...state, phase: "done" };
        // The park's wait marker resumes the loop to the next cycle's clock read.
        if (m.marker === "wait" && state.phase === "park") {
          return { ...state, phase: "read_clock" };
        }
      }
      return state; // effect_intent (no-op by contract), decisions, other markers
    },

    step(state: ScheduleState): Action {
      switch (state.phase) {
        case "read_clock":
          // Retry-safe: a clock read is idempotent. A per-cycle key keeps recovery dedupe
          // unambiguous across cycles; it is deterministic (runs is journaled state).
          return { type: "effect", effectKind: "clock", request: {}, idempotencyKey: `clock@${state.runs}` };
        case "run_job":
          return {
            type: "effect",
            effectKind: job.effectKind,
            request: job.request,
            retrySafe: job.retrySafe ?? false,
            ...(job.idempotencyKey !== undefined ? { idempotencyKey: job.idempotencyKey } : {}),
          };
        case "park":
          return { type: "wait", wait: { kind: "timer", at: state.nextAt } };
        case "done":
          return { type: "finish", output: { runs: state.runs, lastJob: state.lastJob } };
        default:
          throw new Error(`scheduleProgram: unexpected phase '${String(state.phase)}'`);
      }
    },
  };
}
