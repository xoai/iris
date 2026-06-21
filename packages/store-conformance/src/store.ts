// The StateStore conformance cases. Each maps to a guarantee a correct store
// MUST provide; passing the whole list is the definition of an Iris store. Uses
// only the core API (acquireLease/encode/decode) + the StoreFactory, so it runs
// against any backend.
import assert from "node:assert/strict";
import { acquireLease, encode, decode } from "@irisrun/core";
import type { StateStore, Version } from "@irisrun/core";
import type { ConformanceCase, StoreFactory, StoreConformanceOpts } from "./types.ts";

async function fenceFor(store: StateStore, sid: string): Promise<Version> {
  const l = await acquireLease(store, sid, "H");
  assert.ok(l.ok, "acquireLease must succeed on a fresh session");
  return l.ok ? l.fence : 0;
}

export function runStoreConformance(
  make: StoreFactory,
  opts: StoreConformanceOpts = {},
): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const c = (name: string, fn: () => Promise<void>): void => {
    cases.push({ name: `store: ${name}`, fn });
  };

  // --- CAS (the single-writer lease rides this) ------------------------------

  c("cas — first write (expected=null) wins v1; a second null-cas loses with current", async () => {
    const s = await make();
    assert.deepEqual(await s.cas("lease:s", null, encode({ h: "A" })), { ok: true, version: 1 });
    const second = await s.cas("lease:s", null, encode({ h: "B" }));
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.current, 1);
    const got = await s.load("lease:s");
    assert.equal(got?.version, 1);
    assert.deepEqual(decode(got!.bytes), { h: "A" });
  });

  c("cas — versioned advance; a stale expected loses with the real current", async () => {
    const s = await make();
    assert.deepEqual(await s.cas("k", null, encode({ v: 1 })), { ok: true, version: 1 });
    assert.deepEqual(await s.cas("k", 1, encode({ v: 2 })), { ok: true, version: 2 });
    const stale = await s.cas("k", 1, encode({ v: 3 }));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.current, 2);
    assert.deepEqual(decode((await s.load("k"))!.bytes), { v: 2 });
  });

  c("cas — a non-null expected against a never-written key loses (current:0)", async () => {
    const s = await make();
    const r = await s.cas("k", 1, encode({ x: 1 }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.current, 0);
  });

  c("load — a missing key is null", async () => {
    const s = await make();
    assert.equal(await s.load("nope"), null);
  });

  // --- append: dense, fenced, seq_conflict, stale_fence ----------------------

  c("append — dense fenced appends; dense readback; readJournal honors fromSeq", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    assert.deepEqual(await s.append("s", 0, [encode({ n: 0 })], f), { ok: true, seq: 0 });
    assert.deepEqual(await s.append("s", 1, [encode({ n: 1 })], f), { ok: true, seq: 1 });
    const rows = await s.readJournal("s", 0);
    assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
    assert.deepEqual(rows.map((r) => decode(r.bytes)), [{ n: 0 }, { n: 1 }]);
    assert.deepEqual((await s.readJournal("s", 1)).map((r) => r.seq), [1]);
  });

  c("append — a wrong expectedSeq is a seq_conflict carrying the current hwm", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 })], f);
    await s.append("s", 1, [encode({ n: 1 })], f);
    assert.deepEqual(await s.append("s", 5, [encode({ n: 5 })], f), {
      ok: false,
      reason: "seq_conflict",
      currentSeq: 1,
    });
    // re-asserting an already-used seq (0) when hwm=1 also conflicts
    assert.deepEqual(await s.append("s", 0, [encode({ n: 0 })], f), {
      ok: false,
      reason: "seq_conflict",
      currentSeq: 1,
    });
  });

  c("append — an old (lower) fence is rejected loudly as stale_fence", async () => {
    const s = await make();
    const f1 = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 })], f1);
    const f2 = await fenceFor(s, "s"); // takeover raises the fence
    assert.ok(f2 > f1, "a takeover must raise the fence");
    await s.append("s", 1, [encode({ n: 1 })], f2);
    assert.deepEqual(await s.append("s", 2, [encode({ n: 2 })], f1), {
      ok: false,
      reason: "stale_fence",
      currentFence: f2,
    });
  });

  c("append — stale_fence takes precedence over a seq conflict", async () => {
    const s = await make();
    const f1 = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 })], f1);
    const f2 = await fenceFor(s, "s");
    await s.append("s", 1, [encode({ n: 1 })], f2);
    // old fence f1 AND a wrong seq (9): fence is checked first → stale_fence, not seq_conflict
    const r = await s.append("s", 9, [encode({ n: 9 })], f1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "stale_fence");
  });

  // --- snapshot / hwm / truncate (the migrate-into-store contract) -----------

  c("snapshot — writeSnapshot seeds the hwm (snap@K on an empty journal lets K+1 append)", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    await s.writeSnapshot("s", 5, encode({ snap: 5 }));
    const snap = await s.readLatestSnapshot("s");
    assert.equal(snap?.upToSeq, 5);
    assert.deepEqual(decode(snap!.bytes), { snap: 5 });
    assert.deepEqual(await s.append("s", 6, [encode({ n: 6 })], f), { ok: true, seq: 6 });
    assert.deepEqual(await s.append("s", 8, [encode({ n: 8 })], f), {
      ok: false,
      reason: "seq_conflict",
      currentSeq: 6,
    });
  });

  c("truncate — seq numbers are NOT reused after truncation (hwm survives via the snapshot)", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 }), encode({ n: 2 })], f);
    await s.writeSnapshot("s", 2, encode({ snap: 2 }));
    await s.truncateJournal("s", 2);
    assert.deepEqual(await s.readJournal("s", 0), []);
    for (const reused of [0, 1, 2]) {
      const r = await s.append("s", reused, [encode({ n: reused })], f);
      assert.equal(r.ok, false, `seq ${reused} must not be reusable`);
      if (!r.ok) assert.equal(r.reason, "seq_conflict");
    }
    assert.deepEqual(await s.append("s", 3, [encode({ n: 3 })], f), { ok: true, seq: 3 });
  });

  c("snapshot — none → null; with several, readLatestSnapshot is the highest upToSeq", async () => {
    const s = await make();
    assert.equal(await s.readLatestSnapshot("s"), null);
    await s.writeSnapshot("s", 2, encode({ a: 1 }));
    await s.writeSnapshot("s", 9, encode({ b: 1 }));
    const snap = await s.readLatestSnapshot("s");
    assert.equal(snap?.upToSeq, 9);
    assert.deepEqual(decode(snap!.bytes), { b: 1 });
  });

  // --- batch atomicity -------------------------------------------------------

  c("append — a clean multi-record batch lands densely", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    assert.deepEqual(await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 }), encode({ n: 2 })], f), {
      ok: true,
      seq: 2,
    });
    assert.deepEqual((await s.readJournal("s", 0)).map((r) => decode(r.bytes)), [{ n: 0 }, { n: 1 }, { n: 2 }]);
  });

  c("append — a rejected batch persists NOTHING (all-or-nothing)", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 })], f); // hwm=0
    // a batch at the wrong expectedSeq (2, hwm is 0) must be rejected whole
    const r = await s.append("s", 2, [encode({ n: 2 }), encode({ n: 3 })], f);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "seq_conflict");
    // nothing from the rejected batch was written
    assert.deepEqual((await s.readJournal("s", 0)).map((r) => r.seq), [0]);
  });

  // --- G1 multi-session isolation --------------------------------------------

  c("isolation — two sessions' journals, fences and hwm are independent", async () => {
    const s = await make();
    const f1 = await fenceFor(s, "s1");
    const f2 = await fenceFor(s, "s2");
    await s.append("s1", 0, [encode({ s: 1 })], f1);
    await s.append("s1", 1, [encode({ s: 1 })], f1);
    await s.append("s2", 0, [encode({ s: 2 })], f2); // s2 starts at 0, independent of s1's hwm
    assert.deepEqual((await s.readJournal("s1", 0)).map((r) => r.seq), [0, 1]);
    assert.deepEqual((await s.readJournal("s2", 0)).map((r) => r.seq), [0]);
    assert.deepEqual(await s.append("s2", 1, [encode({ s: 2 })], f2), { ok: true, seq: 1 });
  });

  // --- G2 snapshot/journal overlap -------------------------------------------

  c("snapshot — writeSnapshot over an existing journal prefix; truncate removes ≤K, hwm holds", async () => {
    const s = await make();
    const f = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 }), encode({ n: 2 })], f);
    await s.writeSnapshot("s", 1, encode({ snap: 1 })); // snapshot a prefix that overlaps live rows
    assert.equal((await s.readLatestSnapshot("s"))?.upToSeq, 1);
    await s.truncateJournal("s", 1);
    assert.deepEqual((await s.readJournal("s", 0)).map((r) => r.seq), [2]); // only ≤1 removed
    // hwm is still 2 — a reused seq conflicts
    assert.deepEqual(await s.append("s", 0, [encode({ n: 0 })], f), {
      ok: false,
      reason: "seq_conflict",
      currentSeq: 2,
    });
  });

  // --- G3 readJournal edges --------------------------------------------------

  c("readJournal — an empty session is []; fromSeq past the tail is []", async () => {
    const s = await make();
    assert.deepEqual(await s.readJournal("s", 0), []);
    const f = await fenceFor(s, "s");
    await s.append("s", 0, [encode({ n: 0 })], f);
    assert.deepEqual(await s.readJournal("s", 5), []); // fromSeq > hwm
  });

  // --- G6 (opt-in) real-concurrency stress -----------------------------------

  if (opts.concurrency && opts.concurrency > 1) {
    const n = opts.concurrency;
    c(`concurrency — ${n} concurrent null-cas → exactly one wins`, async () => {
      const s = await make();
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => s.cas("lease:s", null, encode({ h: i }))),
      );
      assert.equal(results.filter((r) => r.ok).length, 1, "exactly one null-cas may win");
    });
    c(`concurrency — ${n} concurrent appends at seq 0 → exactly one wins`, async () => {
      const s = await make();
      const f = await fenceFor(s, "s");
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => s.append("s", 0, [encode({ n: i })], f)),
      );
      assert.equal(results.filter((r) => r.ok).length, 1, "exactly one append at seq 0 may win");
    });
  }

  return cases;
}
