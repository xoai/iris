import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, canonicalize, decode, runTurn } from "@iris/core";
import type { JournalRecord } from "@iris/core";
import { resultRec, rec } from "./lib/journal-helpers.ts";
import { sumReducer, sumInitial } from "./lib/sample-program.ts";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import {
  makeCountProgram,
  makePerformers,
  type AddState,
} from "./lib/engine-fixtures.ts";

test("A6: replay(0..n) == replay(snapshot@k, k..n) for sampled k", () => {
  const journal: JournalRecord[] = [];
  for (let i = 0; i < 30; i++) {
    journal.push(resultRec(i, `echo:${i}`, (i % 7) + 1));
  }
  journal.push(rec(30, "marker", { marker: "finish" }));

  const full = replay(sumInitial, journal, sumReducer);
  for (const k of [0, 1, 5, 10, 17, 23, 30, journal.length]) {
    const snapK = replay(sumInitial, journal.slice(0, k), sumReducer);
    const fromSnap = replay(snapK, journal.slice(k), sumReducer);
    assert.equal(
      canonicalize(fromSnap),
      canonicalize(full),
      `snapshot equivalence failed at k=${k}`,
    );
  }
});

test("A6: engine snapshots + truncates; reconstruct from snapshot+tail equals final state", async () => {
  const store = new MemStateStore();
  const out = await runTurn(
    {
      store,
      scheduler: new MemScheduler(),
      clock: new TestClock(),
      program: makeCountProgram(6),
      performers: makePerformers(new TestClock()),
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
      snapshotThreshold: 2, // force several snapshots
    },
    "s",
  );
  assert.equal(out.status, "finished");
  if (out.status === "finished") assert.deepEqual(out.output, { total: 6 });

  // a snapshot exists and the journal was truncated (bounded replay cost)
  const snap = await store.readLatestSnapshot("s");
  assert.ok(snap, "expected a snapshot to be written");
  const tail = await store.readJournal("s", (snap?.upToSeq ?? -1) + 1);
  // 6 effects = 12 records + 1 finish marker = 13; truncation must drop most
  assert.ok(tail.length < 13, `expected truncated tail, got ${tail.length}`);

  // restart path: reconstruct from snapshot + remaining tail
  const snapState = decode(snap!.bytes) as unknown as AddState;
  const recs = tail.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const reconstructed = replay(snapState, recs, (s: AddState, r) => {
    // reuse the program's reducer
    return makeCountProgram(6).reducer(s, r);
  });
  assert.deepEqual(reconstructed, { total: 6, count: 6 });
});

// Spy store to capture snapshot boundaries.
class SpyStore extends MemStateStore {
  snapAt: number[] = [];
  async writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    this.snapAt.push(upToSeq);
    return super.writeSnapshot(sessionId, upToSeq, bytes);
  }
}

test("A6: snapshot never bisects an effect (boundary is never an effect_intent)", async () => {
  const store = new SpyStore();
  await runTurn(
    {
      store,
      scheduler: new MemScheduler(),
      clock: new TestClock(),
      program: makeCountProgram(6),
      performers: makePerformers(new TestClock()),
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
      snapshotThreshold: 2,
      keepHistory: true, // keep full journal so we can inspect every boundary
    },
    "s",
  );

  assert.ok(store.snapAt.length > 0, "expected snapshots");
  const all = await store.readJournal("s", 0);
  const bySeq = new Map<number, JournalRecord>();
  for (const r of all) bySeq.set(r.seq, decode(r.bytes) as unknown as JournalRecord);

  for (const upTo of store.snapAt) {
    const recAt = bySeq.get(upTo);
    assert.ok(recAt, `no record at snapshot boundary seq ${upTo}`);
    assert.notEqual(
      recAt?.kind,
      "effect_intent",
      `snapshot boundary ${upTo} bisects an effect (lands on an intent)`,
    );
  }
});
