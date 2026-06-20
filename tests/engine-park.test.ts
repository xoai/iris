import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, decode } from "@irisrun/core";
import type { JournalRecord, Marker } from "@irisrun/core";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import { parkProgram, makePerformers } from "./lib/engine-fixtures.ts";

test("10b: program parks on wait{timer}; journal ends with a wait marker; scheduler armed", async () => {
  const store = new MemStateStore();
  const scheduler = new MemScheduler();
  const out = await runTurn(
    {
      store,
      scheduler,
      clock: new TestClock(),
      program: parkProgram,
      performers: makePerformers(new TestClock()),
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
    },
    "s",
  );

  assert.equal(out.status, "parked");
  if (out.status === "parked") {
    assert.deepEqual(out.wait, { kind: "timer", at: 100 });
  }

  // durable timer was armed
  assert.deepEqual(scheduler.timers, [{ sessionId: "s", wakeAt: 100 }]);

  // journal: intent → result → wait marker; no finish
  const rows = await store.readJournal("s", 0);
  const recs = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  assert.deepEqual(
    recs.map((r) => r.kind),
    ["effect_intent", "effect_result", "marker"],
  );
  assert.equal((recs[2].payload as Marker).marker, "wait");
});
