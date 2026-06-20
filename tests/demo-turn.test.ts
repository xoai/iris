import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, decode } from "@irisrun/core";
import type { JournalRecord, Marker } from "@irisrun/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";
import { counterProgram, makeDemoPerformers } from "@irisrun/demo";
import { TestClock } from "./lib/mem-store.ts";

// 13: in-process end-to-end — the program parks on the timer, then a re-entry
// (clock advanced) reaches finish. Task 14 proves the same across a real
// process restart.
test("demo: parks on the timer, then resumes in-process to finish", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteStateStore(db);
  const scheduler = new SqliteScheduler(db);
  const sid = "demo1";

  const clock0 = new TestClock(0);
  const turn1 = await runTurn(
    {
      store,
      scheduler,
      clock: clock0,
      program: counterProgram,
      performers: makeDemoPerformers(clock0),
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
    },
    sid,
  );
  assert.equal(turn1.status, "parked");
  if (turn1.status === "parked") {
    assert.deepEqual(turn1.wait, { kind: "timer", at: 10 });
  }

  // journal ends with a wait marker; no finish yet
  const rows = await store.readJournal(sid, 0);
  const last = decode(rows[rows.length - 1].bytes) as unknown as JournalRecord;
  assert.equal(last.kind, "marker");
  assert.equal((last.payload as Marker).marker, "wait");

  // advance the logical clock past the timer and re-enter
  const clock1 = new TestClock(50);
  const turn2 = await runTurn(
    {
      store,
      scheduler,
      clock: clock1,
      program: counterProgram,
      performers: makeDemoPerformers(clock1),
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
    },
    sid,
  );
  assert.equal(turn2.status, "finished");
  if (turn2.status === "finished") {
    assert.deepEqual(turn2.output, { counter: 2, echoed: { counter: 1 } });
  }
});
