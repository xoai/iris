// Chaos & concurrency suite (roadmap v0.2 P2 #6): stress the durability spine
// under CONTENTION, a simulated PARTITION (windowed append faults), a simulated
// REDEPLOY (discard the engine + store handle, reopen over the same on-disk
// data), and CROSS-HOST resume UNDER concurrency — all against the REAL
// persistence backends (store-fs on a temp dir, store-sqlite on a temp file),
// not the in-memory fake. "Real hosts" here = real persistence + a simulated
// co-located restart/partition; the literally-distributed run (live Cloudflare DO
// + a VPS) is a documented residual (docs/reference/security-sandbox-threat-model.md notes
// the analogous boundary), NOT faked with dead code. Only the STORE is the real
// backend (the spine — CAS/fence/journal/snapshot — lives there); the scheduler
// is in-memory. sqlite is synchronous inside BEGIN IMMEDIATE, so the storm
// interleaves at the await boundaries BETWEEN store calls (the lease CAS race),
// while fs has a genuine O_EXCL race — both are real contention on real I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, migrateSession } from "@irisrun/core";
import { MemoryStateStore } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { addProgram, parkProgram, makeCountProgram, makePerformers } from "./lib/engine-fixtures.ts";
import {
  REAL_BACKENDS,
  fsBackend,
  sqliteBackend,
  windowedFaultStore,
  chaosDeps,
  multiParkProgram,
  readRecords,
  assertDenseJournal,
  countEffectResults,
} from "./lib/chaos.ts";

// ── Scenario A — contention storm ───────────────────────────────────────────
for (const mk of REAL_BACKENDS) {
  test(`chaos/A storm (${mk().label}): N concurrent writers never corrupt the journal; state is deterministic`, async () => {
    const be = mk();
    try {
      const store = be.open();
      const N = 8;
      const clk = new TestClock(1);
      const outs = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          runTurn(chaosDeps(store, addProgram, makePerformers(clk), { holderId: `H${i}` }), "s"),
        ),
      );
      // every outcome is well-formed; Promise.all would have rejected on a throw
      for (const o of outs) {
        assert.ok(["finished", "parked", "contended", "aborted"].includes(o.status), `well-formed outcome: ${o.status}`);
      }
      assert.ok(outs.some((o) => o.status === "finished"), "at least one writer commits to finish");
      for (const o of outs) {
        if (o.status === "finished") assert.deepEqual(o.output, { total: 7 }, "no torn / double-applied state");
      }
      await assertDenseJournal(store, "s", assert.ok);
      const recs = await readRecords(store, "s");
      assert.equal(countEffectResults(recs), 2, "each of the 2 effects committed exactly once (CAS serialized the writers)");
      const replayed = replay(addProgram.initial, recs, addProgram.reducer);
      assert.equal(
        canonicalize(replayed),
        canonicalize({ total: 7, count: 2 }),
        "a fresh replay of the contended journal reconstructs the single-writer result",
      );
    } finally {
      be.cleanup();
    }
  });
}

// ── Scenario B — simulated partition / transient takeover ───────────────────
for (const mk of REAL_BACKENDS) {
  test(`chaos/B partition (${mk().label}): append faults (stale_fence + seq_conflict) → at-least-once, exactly-once apply`, async () => {
    const be = mk();
    try {
      const inner = be.open();
      // a bounded partition window: two append faults (both abort reasons), then heal
      const { store, state } = windowedFaultStore(inner, ["stale_fence", "seq_conflict"]);
      const clk = new TestClock(1);
      const program = makeCountProgram(3); // 3 idempotent echo(+1) effects → total 3

      let out = await runTurn(chaosDeps(store, program, makePerformers(clk)), "s");
      let attempts = 1;
      while (out.status !== "finished" && attempts < 20) {
        out = await runTurn(chaosDeps(store, program, makePerformers(clk)), "s");
        attempts += 1;
      }
      assert.equal(out.status, "finished", "the session recovers after the partition heals");
      assert.deepEqual(out.status === "finished" ? out.output : null, { total: 3 });
      assert.ok(state.fired >= 1, "the partition window actually fired");
      // at-least-once with NO double-apply: exactly 3 effect_results in the journal
      const recs = await readRecords(inner, "s");
      assert.equal(countEffectResults(recs), 3, "each effect applied exactly once despite aborts/retries");
      await assertDenseJournal(inner, "s", assert.ok);
    } finally {
      be.cleanup();
    }
  });
}

// ── Scenario C — simulated redeploy recovery (across a snapshot boundary) ────
for (const mk of REAL_BACKENDS) {
  test(`chaos/C redeploy (${mk().label}): discard engine+store handle, reopen over the same data, resume byte-identically`, async () => {
    const be = mk();
    try {
      const clk = new TestClock(1);
      // 1) park with a LOW snapshotThreshold so a snapshot+truncate boundary is crossed
      const store1 = be.open();
      const t1 = await runTurn(chaosDeps(store1, parkProgram, makePerformers(clk), { snapshotThreshold: 2 }), "s");
      assert.equal(t1.status, "parked");
      assert.ok(await store1.readLatestSnapshot("s"), "a snapshot+truncate boundary was crossed before the park");

      // 2) REDEPLOY: drop the store handle, reopen a FRESH store over the same on-disk data
      be.release(store1);
      const store2 = be.open();
      const t2 = await runTurn(chaosDeps(store2, parkProgram, makePerformers(clk), { snapshotThreshold: 2 }), "s");
      assert.equal(t2.status, "finished");

      // 3) byte-identical to a control that never redeployed (in-memory, same program)
      const cstore = new MemoryStateStore();
      const cPark = await runTurn(chaosDeps(cstore, parkProgram, makePerformers(clk), { snapshotThreshold: 2 }), "c");
      assert.equal(cPark.status, "parked");
      const cDone = await runTurn(chaosDeps(cstore, parkProgram, makePerformers(clk), { snapshotThreshold: 2 }), "c");
      assert.equal(cDone.status, "finished");
      assert.deepEqual(
        t2.status === "finished" ? t2.output : null,
        cDone.status === "finished" ? cDone.output : undefined,
        "redeployed output matches the no-redeploy control",
      );
      assert.equal(
        canonicalize(t2.status === "finished" ? t2.state : null),
        canonicalize(cDone.status === "finished" ? cDone.state : null),
        "redeployed state is byte-identical to the control",
      );
    } finally {
      be.cleanup();
    }
  });
}

// ── Scenario D — cross-host resume UNDER concurrency ─────────────────────────
test("chaos/D cross-host concurrency: park on fs, migrate fs→sqlite, two hosts race the resume → exactly one wins", async () => {
  const beA = fsBackend();
  const beB = sqliteBackend();
  try {
    const clk = new TestClock(1);
    const storeA = beA.open();
    const tPark = await runTurn(chaosDeps(storeA, parkProgram, makePerformers(clk), { snapshotThreshold: 2 }), "s");
    assert.equal(tPark.status, "parked");

    // migrate A→B (store-only copy; this ALREADY takes B's lease as "migrator")
    const storeB = beB.open();
    await migrateSession(storeA, storeB, "s");

    // two independent hosts race to resume the migrated session on B
    const [r1, r2] = await Promise.all([
      runTurn(chaosDeps(storeB, parkProgram, makePerformers(clk), { holderId: "hostX" }), "s"),
      runTurn(chaosDeps(storeB, parkProgram, makePerformers(clk), { holderId: "hostY" }), "s"),
    ]);
    const finished = [r1, r2].filter((o) => o.status === "finished");
    assert.equal(finished.length, 1, "exactly one host wins the resume");
    const loser = [r1, r2].find((o) => o.status !== "finished");
    assert.ok(loser, `the loser is fenced out (got ${loser?.status})`); // contended (acquire-race) or aborted
    assert.deepEqual(finished[0].status === "finished" ? finished[0].output : null, { v: 42 }, "winner matches a single-host control");
  } finally {
    beA.cleanup();
    beB.cleanup();
  }
});

// ── Scenario E — determinism under REPEATED chaos (partition + redeploy) ─────
for (const mk of REAL_BACKENDS) {
  test(`chaos/E repeated chaos (${mk().label}): interleaved partitions + redeploys still converge to the clean result`, async () => {
    const be = mk();
    try {
      const clk = new TestClock(1);
      const program = multiParkProgram(6); // 6 effects, parking after each
      const perf = makePerformers(clk);

      let store = be.open();
      let out = await runTurn(chaosDeps(store, program, perf, { snapshotThreshold: 3 }), "s");
      let turns = 1;
      let faults = 0;
      while (out.status !== "finished" && turns < 100) {
        // every other turn, inject a one-fault partition; every 3rd turn, redeploy
        const useFault = turns % 2 === 1;
        const wrapped = useFault ? windowedFaultStore(store, ["stale_fence"]) : { store, state: { fired: 0 } };
        out = await runTurn(chaosDeps(wrapped.store, program, perf, { snapshotThreshold: 3 }), "s");
        faults += wrapped.state.fired;
        if (turns % 3 === 2) {
          be.release(store);
          store = be.open(); // REDEPLOY between turns
        }
        turns += 1;
      }
      assert.equal(out.status, "finished", "the session converges despite repeated chaos");
      assert.deepEqual(out.status === "finished" ? out.output : null, { total: 6 }, "exactly-once apply: total is 6, never double-counted");
      assert.ok(faults >= 1, "at least one partition fired during the run");
    } finally {
      be.cleanup();
    }
  });
}
