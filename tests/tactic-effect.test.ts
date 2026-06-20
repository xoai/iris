// Task 1: a seam consultation IS an effect (effectKind "tactic") performed
// via the existing PerformerRegistry — ZERO engine change. Mirrors
// model-effect.test.ts / model-recovery.test.ts: the engine's generic effect
// path journals intent+result, resume + replay never re-invoke the performer
// (the replay quarantine), and danglingIntent recovery re-performs exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, decode, encode, acquireLease } from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  EffectIntent,
  EffectResult,
  Json,
  Version,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeFakeTactic, type CallCounter } from "./lib/fake-tactic.ts";
import { tacticProgram, type TState } from "./lib/tactic-program.ts";

function deps(store: MemoryStateStore, counter: CallCounter): EngineDeps<TState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: tacticProgram,
    performers: { tactic: makeFakeTactic("finish", "fake", counter) },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

async function appendRec(
  store: MemoryStateStore,
  sid: string,
  record: JournalRecord,
  fence: Version,
): Promise<void> {
  const r = await store.append(sid, record.seq, [encode(record as unknown as Json)], fence);
  assert.ok(r.ok, `setup append failed: ${JSON.stringify(r)}`);
}

function tacticIntent(seq: number): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: {
      effectId: "tactic:0",
      effectKind: "tactic",
      request: { seam: "decideNext", payload: { reason: "test" } },
      retrySafe: false, // a seam consultation carries no idempotencyKey
    },
  };
}
function tacticResult(seq: number): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_result",
    payload: {
      effectId: "tactic:0",
      outcome: { ok: true, value: { seam: "decideNext", tacticId: "fake", choice: "finish" } },
    },
  };
}

test("a seam consultation is a `tactic` effect: intent+result journaled; resume does NOT re-invoke the tactic", async () => {
  const store = new MemoryStateStore();
  const counter: CallCounter = { n: 0 };

  const t1 = await runTurn(deps(store, counter), "s");
  assert.equal(t1.status, "finished");
  const out1 = t1.status === "finished" ? t1.output : undefined;
  assert.deepEqual(out1, { choice: "finish" });
  assert.equal(counter.n, 1, "tactic performer called exactly once on the live turn");

  // second runTurn over the completed session → tactic NOT re-invoked (quarantine)
  const t2 = await runTurn(deps(store, counter), "s");
  assert.equal(t2.status, "finished");
  const out2 = t2.status === "finished" ? t2.output : undefined;
  assert.deepEqual(out2, out1);
  assert.equal(counter.n, 1, "resume must not re-invoke the tactic (count unchanged)");

  // the consultation is journaled as a two-record effect (intent + result)
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const tacticIntents = records.filter(
    (r) => r.kind === "effect_intent" && (r.payload as EffectIntent).effectKind === "tactic",
  );
  const results = records.filter((r) => r.kind === "effect_result");
  assert.equal(tacticIntents.length, 1, "exactly one tactic effect_intent journaled");
  assert.equal(results.length, 1, "exactly one effect_result journaled");

  // the decision rides the effect result VALUE as { seam, tacticId, choice }
  const resultPayload = results[0].payload as EffectResult;
  assert.ok(resultPayload.outcome.ok);
  assert.deepEqual(resultPayload.outcome.ok ? resultPayload.outcome.value : null, {
    seam: "decideNext",
    tacticId: "fake",
    choice: "finish",
  });

  // pure replay reconstructs live state with NO performer (replay never calls a tactic)
  const replayed = replay(tacticProgram.initial, records, tacticProgram.reducer);
  assert.equal(
    canonicalize(replayed),
    canonicalize(t2.status === "finished" ? t2.state : tacticProgram.initial),
  );
});

test("recovery: a dangling `tactic` intent is re-performed exactly once", async () => {
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  await appendRec(store, "s", tacticIntent(0), fence); // intent, no result

  const counter: CallCounter = { n: 0 };
  const out = await runTurn(deps(store, counter), "s");
  assert.equal(out.status, "finished");
  assert.equal(counter.n, 1, "tactic re-performed once on recovery");
  const final = out.status === "finished" ? (out.state as TState) : undefined;
  assert.equal(final?.phase, "done");
});

test("a `tactic` intent WITH its result present is NOT re-performed", async () => {
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  await appendRec(store, "s", tacticIntent(0), fence);
  await appendRec(store, "s", tacticResult(1), fence);

  const counter: CallCounter = { n: 0 };
  const out = await runTurn(deps(store, counter), "s");
  assert.equal(out.status, "finished");
  assert.equal(counter.n, 0, "completed tactic consultation must NOT be re-performed");
});
