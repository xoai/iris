import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, decode } from "@irisrun/core";
import type { EngineDeps, JournalRecord } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeFakeModel, type CallCounter } from "./lib/fake-model.ts";
import { modelProgram, type MState } from "./lib/model-program.ts";

function deps(store: MemoryStateStore, counter: CallCounter): EngineDeps<MState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: modelProgram,
    performers: { model_call: makeFakeModel(counter) },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("B1: model_call is journaled; resume does NOT re-call the provider", async () => {
  const store = new MemoryStateStore();
  const counter: CallCounter = { n: 0 };

  const t1 = await runTurn(deps(store, counter), "s");
  assert.equal(t1.status, "finished");
  const out1 = t1.status === "finished" ? t1.output : undefined;
  assert.deepEqual(out1, {
    reply: { role: "assistant", content: "echo:hi", stopReason: "end_turn" },
  });
  assert.equal(counter.n, 1, "model performer called exactly once on the live turn");

  // second runTurn over the completed session → provider NOT re-called
  const t2 = await runTurn(deps(store, counter), "s");
  assert.equal(t2.status, "finished");
  const out2 = t2.status === "finished" ? t2.output : undefined;
  assert.deepEqual(out2, out1);
  assert.equal(counter.n, 1, "resume must not re-call the model (count unchanged)");

  // and pure replay reconstructs the live state without any performer
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const replayed = replay(modelProgram.initial, records, modelProgram.reducer);
  assert.equal(
    canonicalize(replayed),
    canonicalize(t2.status === "finished" ? t2.state : modelProgram.initial),
  );
});
