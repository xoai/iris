import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, acquireLease, encode } from "@iris/core";
import type { JournalRecord, Json, Version } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeFakeModel, type CallCounter } from "./lib/fake-model.ts";
import { modelProgram, type MState } from "./lib/model-program.ts";

async function appendRec(
  store: MemoryStateStore,
  sid: string,
  record: JournalRecord,
  fence: Version,
): Promise<void> {
  const r = await store.append(sid, record.seq, [encode(record as unknown as Json)], fence);
  assert.ok(r.ok, `setup append failed: ${JSON.stringify(r)}`);
}

function modelIntent(seq: number): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: {
      effectId: "model_call:0",
      effectKind: "model_call",
      request: { model: "fake", messages: [{ role: "user", content: "hi" }] },
      retrySafe: false, // model_call carries no idempotencyKey
    },
  };
}
function modelResult(seq: number): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: "d",
    kind: "effect_result",
    payload: {
      effectId: "model_call:0",
      outcome: { ok: true, value: { role: "assistant", content: "echo:hi", stopReason: "end_turn" } },
    },
  };
}

function deps(
  store: MemoryStateStore,
  counter: CallCounter,
  warnings: string[],
) {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: modelProgram,
    performers: { model_call: makeFakeModel(counter) },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    onWarn: (m: string) => warnings.push(m),
  };
}

test("B2: dangling model_call intent → re-performed once per recovery + retry-unsafe warning", async () => {
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  await appendRec(store, "s", modelIntent(0), fence); // intent, no result

  const counter: CallCounter = { n: 0 };
  const warnings: string[] = [];
  const out = await runTurn(deps(store, counter, warnings), "s");
  assert.equal(out.status, "finished");
  assert.equal(counter.n, 1, "model re-performed once on recovery");
  assert.ok(
    warnings.some((w) => /retry-unsafe/.test(w)),
    `expected a retry-unsafe warning, got ${JSON.stringify(warnings)}`,
  );
  const final = out.status === "finished" ? (out.state as MState) : undefined;
  assert.equal(final?.phase, "done");
});

test("B2: model_call intent WITH result present → NOT re-performed", async () => {
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  await appendRec(store, "s", modelIntent(0), fence);
  await appendRec(store, "s", modelResult(1), fence);

  const counter: CallCounter = { n: 0 };
  const out = await runTurn(deps(store, counter, []), "s");
  assert.equal(out.status, "finished");
  assert.equal(counter.n, 0, "completed model_call must NOT be re-performed");
});
