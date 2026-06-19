import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, acquireLease, encode } from "@iris/core";
import type {
  JournalRecord,
  EffectResult,
  Marker,
  Program,
  Action,
  PerformerRegistry,
  Json,
  Version,
} from "@iris/core";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";

// A program that finishes once it has a recovered/echo result.
interface RS extends Record<string, Json> {
  got: boolean;
  value: Json;
  folds: number;
}
const rInitial: RS = { got: false, value: null, folds: 0 };
const rProgram: Program<RS> = {
  initial: rInitial,
  reducer: (state, r: JournalRecord) => {
    if (r.kind === "effect_result") {
      const p = r.payload as EffectResult;
      if (p.outcome.ok) {
        return { got: true, value: p.outcome.value, folds: state.folds + 1 };
      }
      return state;
    }
    return state;
  },
  step: (state): Action =>
    state.got
      ? { type: "finish", output: { value: state.value, folds: state.folds } }
      : { type: "effect", effectKind: "echo", request: 1, idempotencyKey: "k" },
};

async function appendRec(
  store: MemStateStore,
  sid: string,
  record: JournalRecord,
  fence: Version,
): Promise<void> {
  const r = await store.append(
    sid,
    record.seq,
    [encode(record as unknown as Json)],
    fence,
  );
  assert.ok(r.ok, `setup append failed: ${JSON.stringify(r)}`);
}

function intent(
  seq: number,
  effectId: string,
  request: Json,
  retrySafe: boolean,
): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: { effectId, effectKind: "echo", request, retrySafe },
  };
}
function result(seq: number, effectId: string, value: Json): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_result",
    payload: { effectId, outcome: { ok: true, value } },
  };
}

function deps(
  store: MemStateStore,
  performers: PerformerRegistry,
  onWarn?: (m: string) => void,
) {
  return {
    store,
    scheduler: new MemScheduler(),
    clock: new TestClock(),
    program: rProgram,
    performers,
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    ...(onWarn ? { onWarn } : {}),
  };
}

test("A5(1): dangling intent with no result → re-performed exactly once, no double-apply", async () => {
  const store = new MemStateStore();
  const a = await acquireLease(store, "s", "setup");
  const fence: Version = a.ok ? a.fence : 0;
  await appendRec(store, "s", intent(0, "echo:0", 7, true), fence);

  let calls = 0;
  const performers: PerformerRegistry = {
    echo: async (req: Json) => {
      calls += 1;
      return { ok: true, value: req };
    },
  };
  const out = await runTurn(deps(store, performers), "s");
  assert.equal(calls, 1, "keyed effect must be re-performed exactly once");
  assert.equal(out.status, "finished");
  if (out.status === "finished") {
    assert.deepEqual(out.output, { value: 7, folds: 1 });
  }
});

test("A5(2): intent WITH result present → not re-performed", async () => {
  const store = new MemStateStore();
  const a = await acquireLease(store, "s", "setup");
  const fence: Version = a.ok ? a.fence : 0;
  await appendRec(store, "s", intent(0, "echo:0", 7, true), fence);
  await appendRec(store, "s", result(1, "echo:0", 7), fence);

  let calls = 0;
  const performers: PerformerRegistry = {
    echo: async (req: Json) => {
      calls += 1;
      return { ok: true, value: req };
    },
  };
  const out = await runTurn(deps(store, performers), "s");
  assert.equal(calls, 0, "completed effect must NOT be re-performed");
  assert.equal(out.status, "finished");
  if (out.status === "finished") {
    assert.deepEqual(out.output, { value: 7, folds: 1 });
  }
});

test("A5(3): unkeyed (retry-unsafe) dangling intent → re-performed + warned, never silently dropped", async () => {
  const store = new MemStateStore();
  const a = await acquireLease(store, "s", "setup");
  const fence: Version = a.ok ? a.fence : 0;
  await appendRec(store, "s", intent(0, "echo:0", 9, /*retrySafe*/ false), fence);

  let calls = 0;
  const warnings: string[] = [];
  const performers: PerformerRegistry = {
    echo: async (req: Json) => {
      calls += 1;
      return { ok: true, value: req };
    },
  };
  const out = await runTurn(
    deps(store, performers, (m) => warnings.push(m)),
    "s",
  );
  assert.equal(calls, 1);
  assert.ok(
    warnings.some((w) => /retry-unsafe/.test(w)),
    `expected a retry-unsafe warning, got: ${JSON.stringify(warnings)}`,
  );
  assert.equal(out.status, "finished");
});

test("A5(4): two results for one effectId can never both fold (replay dedupe)", async () => {
  const store = new MemStateStore();
  const a = await acquireLease(store, "s", "setup");
  const fence: Version = a.ok ? a.fence : 0;
  await appendRec(store, "s", intent(0, "echo:0", 7, true), fence);
  await appendRec(store, "s", result(1, "echo:0", 7), fence);
  await appendRec(store, "s", result(2, "echo:0", 7), fence); // pathological duplicate

  let calls = 0;
  const performers: PerformerRegistry = {
    echo: async (req: Json) => {
      calls += 1;
      return { ok: true, value: req };
    },
  };
  const out = await runTurn(deps(store, performers), "s");
  assert.equal(calls, 0);
  assert.equal(out.status, "finished");
  if (out.status === "finished") {
    // folds === 1 proves the duplicate result did not double-apply
    assert.deepEqual(out.output, { value: 7, folds: 1 });
  }
});
