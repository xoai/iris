// The durability engine: runTurn (spec §6; framework Spec 00 §turn). Acquire
// lease → replay → recover → step/effect/wait/finish, checkpoint-before-effect
// with the replay-consistency assertion after every committed step. No I/O of
// its own — store, scheduler, clock, and performers are all injected.
import type { Json } from "./json.ts";
import type { StateStore, Scheduler } from "./ports.ts";
import type {
  Program,
  PerformerRegistry,
  Outcome,
} from "./program.ts";
import type {
  JournalRecord,
  RecordKind,
  RecordPayload,
  EffectIntent,
  EffectResult,
  WaitSpec,
} from "./journal.ts";
import type { LogicalClock } from "./clock.ts";
import { decode, encode } from "./json.ts";
import { replay } from "./replay.ts";
import { assertReplayConsistency } from "./assertion.ts";
import { effectId } from "./effect-id.ts";
import { acquireLease, releaseLease } from "./lease.ts";
import { shouldSnapshot, DEFAULT_SNAPSHOT_THRESHOLD } from "./snapshot.ts";

export class LeaseLost extends Error {
  currentFence: number;
  constructor(currentFence: number) {
    super(`lease lost: a higher fence took over (current ${currentFence})`);
    this.name = "LeaseLost";
    this.currentFence = currentFence;
  }
}

export class SeqConflict extends Error {
  currentSeq: number;
  constructor(currentSeq: number) {
    super(`seq conflict: journal advanced (currentSeq ${currentSeq})`);
    this.name = "SeqConflict";
    this.currentSeq = currentSeq;
  }
}

export interface EngineDeps<S extends Json> {
  store: StateStore;
  scheduler: Scheduler;
  clock: LogicalClock;
  program: Program<S>;
  performers: PerformerRegistry;
  defDigest: string;
  holderId: string;
  assertReplay?: boolean; // default true (dev/test) — set by the runner from IRIS_ASSERT
  snapshotThreshold?: number; // default 64 (spec §3.7)
  keepHistory?: boolean; // if true, do not truncate the journal after a snapshot
  maxStepsPerTurn?: number; // default 10000 — safety guard (kernel cap lands in M2)
  onWarn?: (message: string) => void; // surfaces retry-unsafe recovery, etc.
  // Read-only, post-commit observer. Fires once per NEWLY committed journal
  // record, in seq order, with a DEEP COPY (never the live `tail` reference) so a
  // consumer cannot mutate the record the assertion folds. Never fires for
  // replayed history (replay does not commit). A throw is swallowed + warned —
  // the record already committed durably, so a buggy observer must not abort the
  // turn. Same best-effort side-channel posture as `onWarn`. Used by streaming
  // channels (SSE/WS) to surface the turn's journal timeline live.
  onRecord?: (record: JournalRecord) => void;
}

export type TurnOutcome<S> =
  | { status: "finished"; output?: Json; state: S }
  | { status: "parked"; wait: WaitSpec; state: S }
  | { status: "contended"; current: number }
  | { status: "aborted"; reason: "lease_lost" | "seq_conflict"; state: S };

function warn<S extends Json>(deps: EngineDeps<S>, message: string): void {
  if (deps.onWarn) deps.onWarn(message);
  else console.warn(`[iris] ${message}`);
}

async function performEffect(
  performers: PerformerRegistry,
  intent: EffectIntent,
): Promise<Outcome> {
  const perf = performers[intent.effectKind];
  if (!perf) {
    // A missing performer is a configuration/programming error, not an effect
    // outcome. Fail LOUDLY — do not launder it into a journaled {ok:false} that
    // a reducer might treat as a no-op (which would spin the step loop).
    throw new Error(
      `no performer registered for effect kind '${intent.effectKind}'`,
    );
  }
  // A performer that THREW is a recordable failure (the effect ran and failed),
  // distinct from an absent performer above.
  try {
    return await perf(intent.request, intent.idempotencyKey);
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e) },
    };
  }
}

// The trailing effect_intent whose effectId has no effect_result anywhere —
// i.e. recovery is needed (spec §3.5). Returns null otherwise.
function danglingIntent(tail: JournalRecord[]): EffectIntent | null {
  const results = new Set<string>();
  for (const r of tail) {
    if (r.kind === "effect_result") {
      results.add((r.payload as EffectResult).effectId);
    }
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i];
    if (r.kind === "effect_intent") {
      const intent = r.payload as EffectIntent;
      return results.has(intent.effectId) ? null : intent;
    }
  }
  return null;
}

export async function runTurn<S extends Json>(
  deps: EngineDeps<S>,
  sessionId: string,
): Promise<TurnOutcome<S>> {
  const { store, scheduler, clock, program, performers, defDigest } = deps;
  const assertOn = deps.assertReplay !== false;
  const snapshotThreshold = deps.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;
  const maxSteps = deps.maxStepsPerTurn ?? 10000;

  const lease = await acquireLease(store, sessionId, deps.holderId);
  if (!lease.ok) return { status: "contended", current: lease.current };
  const fence = lease.fence;

  let state: S = program.initial;
  try {
    const snap = await store.readLatestSnapshot(sessionId);
    const snapState: S = snap
      ? (decode(snap.bytes) as unknown as S)
      : program.initial;
    const snapUpTo = snap ? snap.upToSeq : -1;

    const rows = await store.readJournal(sessionId, snapUpTo + 1);
    const tail: JournalRecord[] = rows.map(
      (r) => decode(r.bytes) as unknown as JournalRecord,
    );
    state = replay(snapState, tail, program.reducer);
    // seq cursor = authoritative STORE row seq (the store's position is the
    // source of truth, not a record's self-reported seq). Empty-tail fallback =
    // snapUpTo (spec §6) — never -1 when a snapshot exists.
    let seq = rows.length ? rows[rows.length - 1].seq : snapUpTo;
    let lastSnapshotSeq = snapUpTo;

    const commit = async (
      kind: RecordKind,
      payload: RecordPayload,
    ): Promise<JournalRecord> => {
      const nextSeq = seq + 1;
      const record: JournalRecord = {
        seq: nextSeq,
        ts: clock.now(),
        defDigest,
        kind,
        payload,
      };
      const r = await store.append(
        sessionId,
        nextSeq,
        [encode(record as unknown as Json)],
        fence,
      );
      if (!r.ok) {
        if (r.reason === "stale_fence") throw new LeaseLost(r.currentFence);
        throw new SeqConflict(r.currentSeq);
      }
      seq = r.seq;
      tail.push(record);
      if (deps.onRecord) {
        // Deep copy: a consumer must not be able to mutate `tail` (which the
        // replay assertion folds). structuredClone is total over a JournalRecord
        // (every field is Json) and avoids re-canonicalizing. Guarded: a throwing
        // observer must NOT abort a turn whose record already durably committed.
        try {
          deps.onRecord(structuredClone(record));
        } catch (e) {
          warn(deps, `onRecord observer threw (ignored): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return record;
    };

    const assertNow = (): void => {
      if (assertOn) {
        assertReplayConsistency(state, snapState, tail, program.reducer);
      }
    };

    // RECOVERY (spec §3.5): re-perform a dangling intent exactly once. effectId
    // is READ FROM THE STORED INTENT — never recomputed.
    const dangling = danglingIntent(tail);
    if (dangling) {
      if (!dangling.retrySafe) {
        warn(
          deps,
          `recovery re-performing a retry-unsafe effect (effectId=${dangling.effectId}, kind=${dangling.effectKind}); possible re-execution`,
        );
      }
      const outcome = await performEffect(performers, dangling);
      const resultRec = await commit("effect_result", {
        effectId: dangling.effectId,
        outcome,
      });
      state = program.reducer(state, resultRec);
      assertNow();
    }

    for (let stepCount = 0; ; stepCount++) {
      if (stepCount >= maxSteps) {
        throw new Error(
          `runTurn exceeded maxStepsPerTurn (${maxSteps}) — program never parked or finished`,
        );
      }
      const action = program.step(state);

      if (action.type === "effect") {
        const eid = effectId(seq + 1, action.effectKind);
        const intent: EffectIntent = {
          effectId: eid,
          effectKind: action.effectKind,
          request: action.request,
          retrySafe: action.retrySafe ?? action.idempotencyKey !== undefined,
          ...(action.idempotencyKey !== undefined
            ? { idempotencyKey: action.idempotencyKey }
            : {}),
        };
        const intentRec = await commit("effect_intent", intent);
        state = program.reducer(state, intentRec); // no-op by contract
        assertNow();

        const outcome = await performEffect(performers, intent);
        const resultRec = await commit("effect_result", {
          effectId: eid,
          outcome,
        });
        state = program.reducer(state, resultRec);
        assertNow();

        // snapshot ONLY after a complete effect — never bisecting intent/result.
        // (Spec §6 also allows snapshotting after a marker; in this slice the
        // only markers — wait/finish — terminate the turn, so there is no
        // mid-turn marker continuation to snapshot. Revisit when M2 adds
        // mid-turn decision/marker steps.)
        if (shouldSnapshot(seq, lastSnapshotSeq, snapshotThreshold)) {
          await store.writeSnapshot(sessionId, seq, encode(state));
          if (!deps.keepHistory) await store.truncateJournal(sessionId, seq);
          lastSnapshotSeq = seq;
        }
      } else if (action.type === "wait") {
        const m = await commit("marker", { marker: "wait", wait: action.wait });
        state = program.reducer(state, m);
        assertNow();
        if (action.wait.kind === "timer") {
          await scheduler.sleepUntil(sessionId, action.wait.at);
        } else if (action.wait.kind === "signal") {
          await scheduler.waitForSignal(sessionId, action.wait.name);
        }
        // 'user' wait: nothing to schedule; the next message re-enters
        return { status: "parked", wait: action.wait, state };
      } else {
        const m = await commit(
          "marker",
          action.output !== undefined
            ? { marker: "finish", output: action.output }
            : { marker: "finish" },
        );
        state = program.reducer(state, m);
        assertNow();
        return { status: "finished", output: action.output, state };
      }
    }
  } catch (err) {
    if (err instanceof LeaseLost) {
      return { status: "aborted", reason: "lease_lost", state };
    }
    if (err instanceof SeqConflict) {
      return { status: "aborted", reason: "seq_conflict", state };
    }
    throw err;
  } finally {
    await releaseLease(store, sessionId, fence);
  }
}
