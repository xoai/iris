import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, ReplayDivergenceError } from "@iris/core";
import type {
  EngineDeps,
  JournalRecord,
  Program,
  Action,
  PerformerRegistry,
  Json,
} from "@iris/core";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import {
  addProgram,
  makePerformers,
  type AddState,
} from "./lib/engine-fixtures.ts";

function baseDeps(
  store: MemStateStore,
  performers: PerformerRegistry,
): EngineDeps<AddState> {
  return {
    store,
    scheduler: new MemScheduler(),
    clock: new TestClock(1000),
    program: addProgram,
    performers,
    defDigest: "sha256:img",
    holderId: "H",
    assertReplay: true,
  };
}

test("10a: a 2-effect program runs to finish with the expected output", async () => {
  const store = new MemStateStore();
  const out = await runTurn(baseDeps(store, makePerformers(new TestClock())), "s");
  assert.equal(out.status, "finished");
  if (out.status === "finished") assert.deepEqual(out.output, { total: 7 });
});

test("10a: the replay assertion is wired into the loop (a nondeterministic reducer throws)", async () => {
  // A program whose reducer reads an external counter — live and replay diverge.
  let nd = 0;
  interface BadS extends Record<string, Json> {
    nd: number;
    count: number;
  }
  const badProgram: Program<BadS> = {
    initial: { nd: 0, count: 0 },
    reducer: (state, r: JournalRecord) => {
      if (r.kind === "effect_result") {
        nd += 1;
        return { nd, count: state.count + 1 };
      }
      return state;
    },
    step: (state): Action =>
      state.count === 0
        ? { type: "effect", effectKind: "echo", request: 1, idempotencyKey: "k" }
        : { type: "finish" },
  };
  const store = new MemStateStore();
  await assert.rejects(
    runTurn(
      {
        store,
        scheduler: new MemScheduler(),
        clock: new TestClock(),
        program: badProgram,
        performers: makePerformers(new TestClock()),
        defDigest: "d",
        holderId: "H",
        assertReplay: true,
      },
      "s",
    ),
    ReplayDivergenceError,
  );
});

test("10a: checkpoint-before-effect — the intent is committed before the performer runs", async () => {
  const store = new MemStateStore();
  const performers: PerformerRegistry = {
    echo: async (request: Json) => {
      // when the performer runs, the just-checkpointed intent must already be
      // the last durable record.
      const rows = await store.readJournal("s", 0);
      const last = rows[rows.length - 1];
      const rec = decode(last.bytes) as unknown as JournalRecord;
      assert.equal(rec.kind, "effect_intent", "performer ran before intent was durable");
      return { ok: true, value: request };
    },
  };
  const out = await runTurn(baseDeps(store, performers), "s");
  assert.equal(out.status, "finished");
});

test("10a: a missing performer fails loudly (throws), not laundered into an outcome", async () => {
  const store = new MemStateStore();
  // addProgram needs an `echo` performer; provide none.
  await assert.rejects(
    runTurn(baseDeps(store, {}), "s"),
    /no performer registered/,
  );
});

test("10a: stale fence mid-turn → aborted lease_lost, journal not corrupted", async () => {
  const store = new MemStateStore();
  let bumped = false;
  const performers: PerformerRegistry = {
    echo: async (request: Json) => {
      if (!bumped) {
        bumped = true;
        store.forceFence("s", 9999); // simulate a higher-fence takeover
      }
      return { ok: true, value: request };
    },
  };
  const out = await runTurn(baseDeps(store, performers), "s");
  assert.equal(out.status, "aborted");
  if (out.status === "aborted") assert.equal(out.reason, "lease_lost");
  // the first intent committed, but its result was rejected — no result present
  const rows = await store.readJournal("s", 0);
  const kinds = rows.map(
    (r) => (require_decode(r.bytes) as unknown as JournalRecord).kind,
  );
  assert.deepEqual(kinds, ["effect_intent"]);
});

test("10a: seq conflict mid-turn → aborted seq_conflict; a clean re-entry completes", async () => {
  const store = new MemStateStore();

  // Faulty performer: on first call, an intruder appends a harmless marker,
  // advancing the seq so the engine's result append hits seq_conflict.
  let injected = false;
  const faulty: PerformerRegistry = {
    echo: async (request: Json) => {
      if (!injected) {
        injected = true;
        const marker: JournalRecord = {
          seq: 1, // matches its store position (the engine uses store seq anyway)
          ts: 0,
          defDigest: "d",
          kind: "marker",
          payload: { marker: "turn_started" },
        };
        store.forceAppendRaw("s", encode_record(marker), 1);
      }
      return { ok: true, value: request };
    },
  };
  const aborted = await runTurn(baseDeps(store, faulty), "s");
  assert.equal(aborted.status, "aborted");
  if (aborted.status === "aborted") assert.equal(aborted.reason, "seq_conflict");

  // Clean re-entry: recovers the dangling intent + completes.
  const done = await runTurn(baseDeps(store, makePerformers(new TestClock())), "s");
  assert.equal(done.status, "finished");
  if (done.status === "finished") assert.deepEqual(done.output, { total: 7 });
});

// tiny local decode/encode helpers (avoid top-level await churn)
import { decode, encode } from "@iris/core";
function require_decode(b: Uint8Array): Json {
  return decode(b);
}
function encode_record(r: JournalRecord): Uint8Array {
  return encode(r as unknown as Json);
}
