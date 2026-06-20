import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, migrateSession, canonicalize } from "@irisrun/core";
import type { EngineDeps, Json } from "@irisrun/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeCrossProgram, type XState } from "./lib/cross-store-program.ts";

const N = 3;

function deps(
  store: EngineDeps<XState>["store"],
  scheduler: EngineDeps<XState>["scheduler"],
  now: number,
  snapshotThreshold: number,
): EngineDeps<XState> {
  const clock = new TestClock(now);
  return {
    store,
    scheduler,
    clock,
    program: makeCrossProgram(N),
    performers: { echo: async (request: Json) => ({ ok: true, value: request }) },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    snapshotThreshold,
  };
}

test("B4: park on SQLite, migrate across a snapshot boundary to memory, resume identical", async () => {
  // --- baseline: single store (default threshold, no snapshot) ---
  const base = new MemoryStateStore();
  const baseSched = new MemoryScheduler();
  const t1 = await runTurn(deps(base, baseSched, 0, 64), "s");
  assert.equal(t1.status, "parked");
  const t2 = await runTurn(deps(base, baseSched, 200, 64), "s");
  assert.equal(t2.status, "finished");
  const expected = t2.status === "finished" ? t2.output : undefined;
  const baselineState = t2.status === "finished" ? t2.state : undefined;
  assert.deepEqual(expected, { count: N });

  // --- cross-store: SQLite A (low threshold → snapshots+truncates), park ---
  const A = new SqliteStateStore(openDatabase(":memory:"));
  const aSched = new SqliteScheduler(openDatabase(":memory:"));
  const parked = await runTurn(deps(A, aSched, 0, 2), "x");
  assert.equal(parked.status, "parked");

  // the snapshot boundary is REAL (not a vacuous migration)
  const snap = await A.readLatestSnapshot("x");
  assert.ok(snap, "expected store A to have snapshotted before the park");

  // migrate A → memory B across the snapshot boundary
  const B = new MemoryStateStore();
  const mig = await migrateSession(A, B, "x");
  assert.equal(mig.snapshotUpTo, snap?.upToSeq);

  // resume on B = a DIRECT runTurn on B (advance the clock; B's scheduler has
  // no migrated timer row, and the journal already records the parked wait)
  const resumed = await runTurn(deps(B, new MemoryScheduler(), 200, 64), "x");
  assert.equal(resumed.status, "finished");
  const got = resumed.status === "finished" ? resumed.output : undefined;

  // identical continuation across the store switch — output AND full state
  assert.deepEqual(got, expected);
  const resumedState = resumed.status === "finished" ? resumed.state : undefined;
  assert.equal(
    canonicalize(resumedState as Json),
    canonicalize(baselineState as Json),
    "cross-store resumed state must byte-equal the single-store baseline state",
  );
});
