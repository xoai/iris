// onRecord (serve-streaming Task 1): a read-only, post-commit observer fired once
// per NEWLY committed journal record, in seq order, with a DEEP COPY. It must not
// perturb determinism (state/outcome identical with vs without it), a mutating
// consumer must not corrupt replay, a throwing consumer must not abort a
// committed turn, and replayed/recovered HISTORY must never be re-emitted (only
// the genuinely-new recovery effect_result is).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, acquireLease, encode } from "@irisrun/core";
import type {
  JournalRecord,
  EffectResult,
  Marker,
  Program,
  Action,
  PerformerRegistry,
  Json,
  Version,
} from "@irisrun/core";
import { runTurnOn, type HostAdapter } from "@irisrun/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";

// --- an authored TWO-effect program: echo 10, echo 20, then finish -----------
interface TwoState extends Record<string, Json> {
  vals: number[];
  done: boolean;
}
const twoInitial: TwoState = { vals: [], done: false };
const twoProgram: Program<TwoState> = {
  initial: twoInitial,
  reducer: (state, r: JournalRecord): TwoState => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok && typeof p.outcome.value === "number") {
        return { ...state, vals: [...state.vals, p.outcome.value] };
      }
      return state;
    }
    if (r.kind === "marker" && (r.payload as Marker).marker === "finish") {
      return { ...state, done: true };
    }
    return state;
  },
  step: (state): Action => {
    if (state.vals.length === 0)
      return { type: "effect", effectKind: "echo", request: 10, idempotencyKey: "a" };
    if (state.vals.length === 1)
      return { type: "effect", effectKind: "echo", request: 20, idempotencyKey: "b" };
    return { type: "finish", output: { sum: state.vals[0] + state.vals[1] } };
  },
};
const echoPerformers: PerformerRegistry = {
  echo: async (req: Json) => ({ ok: true, value: req }),
};

function deps(
  store: MemStateStore,
  program: Program<TwoState>,
  performers: PerformerRegistry,
  extra: {
    onRecord?: (r: JournalRecord) => void;
    onWarn?: (m: string) => void;
  } = {},
) {
  return {
    store,
    scheduler: new MemScheduler(),
    clock: new TestClock(),
    program,
    performers,
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    ...(extra.onRecord ? { onRecord: extra.onRecord } : {}),
    ...(extra.onWarn ? { onWarn: extra.onWarn } : {}),
  };
}

test("onRecord: emits every committed record in seq order over a multi-effect turn (intents + results both)", async () => {
  const store = new MemStateStore();
  const seen: JournalRecord[] = [];
  const out = await runTurn(
    deps(store, twoProgram, echoPerformers, { onRecord: (r) => seen.push(r) }),
    "s",
  );
  assert.equal(out.status, "finished");
  if (out.status === "finished") assert.deepEqual(out.output, { sum: 30 });

  assert.deepEqual(
    seen.map((r) => r.kind),
    ["effect_intent", "effect_result", "effect_intent", "effect_result", "marker"],
  );
  assert.deepEqual(seen.map((r) => r.seq), [0, 1, 2, 3, 4], "seq order, dense");
  // both intents carry the echo effect
  assert.equal((seen[0].payload as { effectKind: string }).effectKind, "echo");
  assert.equal((seen[2].payload as { effectKind: string }).effectKind, "echo");
});

test("onRecord: state + outcome are IDENTICAL with vs without the observer (determinism preserved)", async () => {
  const control = await runTurn(deps(new MemStateStore(), twoProgram, echoPerformers), "s");
  const observed = await runTurn(
    deps(new MemStateStore(), twoProgram, echoPerformers, { onRecord: () => {} }),
    "s",
  );
  assert.deepEqual(observed, control);
});

test("onRecord: a MUTATING consumer cannot corrupt replay (deep copy)", async () => {
  const control = await runTurn(deps(new MemStateStore(), twoProgram, echoPerformers), "s");
  // a hostile observer scribbles all over the record it receives
  const poisoned = await runTurn(
    deps(new MemStateStore(), twoProgram, echoPerformers, {
      onRecord: (r) => {
        (r as { seq: number }).seq = -999;
        (r.payload as Record<string, Json>).poisoned = true;
        if (r.kind === "effect_result") {
          (r.payload as unknown as EffectResult).outcome = { ok: true, value: 99999 };
        }
      },
    }),
    "s",
  );
  assert.deepEqual(poisoned, control, "the engine's state/outcome is unaffected by observer mutation");
});

test("onRecord: a THROWING consumer is swallowed + warned; the turn still commits", async () => {
  const store = new MemStateStore();
  const warnings: string[] = [];
  const out = await runTurn(
    deps(store, twoProgram, echoPerformers, {
      onRecord: () => {
        throw new Error("boom");
      },
      onWarn: (m) => warnings.push(m),
    }),
    "s",
  );
  assert.equal(out.status, "finished");
  if (out.status === "finished") assert.deepEqual(out.output, { sum: 30 });
  assert.ok(
    warnings.some((w) => /onRecord/.test(w)),
    `expected an onRecord-threw warning, got ${JSON.stringify(warnings)}`,
  );
  // the journal advanced regardless: 5 records were durably appended
  const rows = await store.readJournal("s", 0);
  assert.equal(rows.length, 5, "all five records durably committed despite the throwing observer");
});

// --- recovery: a resumed turn emits the NEW recovery result, NOT prior history -
interface RS extends Record<string, Json> {
  got: boolean;
  value: Json;
}
const rProgram: Program<RS> = {
  initial: { got: false, value: null },
  reducer: (state, r: JournalRecord): RS => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok) return { got: true, value: p.outcome.value };
    }
    return state;
  },
  step: (state): Action =>
    state.got
      ? { type: "finish", output: { value: state.value } }
      : { type: "effect", effectKind: "echo", request: 7, idempotencyKey: "k" },
};

test("onRecord: threads through @irisrun/host runTurnOn (the per-request seam, not TurnInputs)", async () => {
  const store = new MemStateStore();
  const adapter: HostAdapter = {
    name: "test-host",
    capabilities: { long_running: true },
    store,
    scheduler: new MemScheduler(),
  };
  const seen: JournalRecord[] = [];
  const out = await runTurnOn(adapter, {
    sessionId: "s",
    defDigest: "d",
    program: twoProgram,
    performers: echoPerformers,
    clock: new TestClock(),
    onRecord: (r) => seen.push(r),
  });
  assert.equal(out.status, "finished");
  assert.deepEqual(seen.map((r) => r.kind), [
    "effect_intent",
    "effect_result",
    "effect_intent",
    "effect_result",
    "marker",
  ]);
});

test("onRecord: on a resumed turn, prior history is NOT re-emitted; the recovery effect_result IS emitted once", async () => {
  const store = new MemStateStore();
  const a = await acquireLease(store, "s", "setup");
  const fence: Version = a.ok ? a.fence : 0;
  // pre-seed a DANGLING intent (seq 0) with no result — recovery will re-perform it
  const danglingIntent: JournalRecord = {
    seq: 0,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: { effectId: "echo:0", effectKind: "echo", request: 7, retrySafe: true },
  };
  const r = await store.append("s", 0, [encode(danglingIntent as unknown as Json)], fence);
  assert.ok(r.ok);

  const seen: JournalRecord[] = [];
  const out = await runTurn(
    deps(store, rProgram as unknown as Program<TwoState>, echoPerformers, {
      onRecord: (rec) => seen.push(rec),
    }),
    "s",
  );
  assert.equal(out.status, "finished");

  const seqs = seen.map((x) => x.seq);
  assert.ok(!seqs.includes(0), `prior dangling intent (seq 0) must NOT be re-emitted; saw ${JSON.stringify(seqs)}`);
  const results = seen.filter((x) => x.kind === "effect_result");
  assert.equal(results.length, 1, "exactly one (recovery) effect_result emitted");
  assert.equal(results[0].seq, 1, "the recovery result is the new seq-1 append");
});
