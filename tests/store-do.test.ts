// M6 T2 — @irisrun/store-do DoStateStore conformance (spec §2.2). The edge store
// (Cloudflare Durable Objects, cold-per-isolate over a narrow DoStorage) MUST
// enforce the SAME invariants the sqlite/fs stores enforce: true CAS (compare-
// and-write inside ONE storage.transaction — atomic, no check→await→mutate gap),
// fenced+dense append (stale_fence precedence OVER seq_conflict), an hwm that
// survives truncation, writeSnapshot-SEEDS-hwm (the migrate-into-edge contract),
// and the cold-isolate property (a FRESH DoStateStore over the same DoStorage
// reads identical state). Same conformance shape as store-fs.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireLease } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { DoStateStore } from "@irisrun/store-do";
import { FakeDoStorage } from "./lib/fake-do.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// --- CAS (the lease rides this) ---------------------------------------------

test("T2 cas: first write (expected=null) → {ok,version:1}; a second null-cas loses with current:1", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const r1 = await store.cas("lease:s", null, enc("a"));
  assert.deepEqual(r1, { ok: true, version: 1 });
  const r2 = await store.cas("lease:s", null, enc("b"));
  assert.deepEqual(r2, { ok: false, current: 1 });
  const got = await store.load("lease:s");
  assert.equal(got?.version, 1);
  assert.equal(dec(got!.bytes), "a");
});

test("T2 cas: versioned CAS advances, and a stale expected loses with the real current", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  assert.deepEqual(await store.cas("k", null, enc("v1")), { ok: true, version: 1 });
  assert.deepEqual(await store.cas("k", 1, enc("v2")), { ok: true, version: 2 });
  assert.deepEqual(await store.cas("k", 1, enc("v3")), { ok: false, current: 2 });
  assert.equal(dec((await store.load("k"))!.bytes), "v2");
});

test("T2 cas: a non-null expected against a never-written key loses (current:0)", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  assert.deepEqual(await store.cas("k", 1, enc("x")), { ok: false, current: 0 });
});

test("T2 load: a missing key is null", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  assert.equal(await store.load("nope"), null);
});

// --- CAS atomicity: concurrent first-acquire — exactly one wins --------------

test("T2 cas: two concurrent null-CAS on the same key — exactly one wins (atomic inside one transaction)", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const [a, b] = await Promise.all([
    store.cas("lease:race", null, enc("A")),
    store.cas("lease:race", null, enc("B")),
  ]);
  const wins = [a, b].filter((r) => r.ok).length;
  assert.equal(wins, 1, "exactly one acquirer wins the first-acquire race");
  const loser = a.ok ? b : a;
  assert.deepEqual(loser, { ok: false, current: 1 });
});

// --- append: dense, fenced, seq_conflict, stale_fence -----------------------

async function leaseFence(store: DoStateStore, sid: string): Promise<Version> {
  const l = await acquireLease(store, sid, "H");
  assert.ok(l.ok, "lease acquire failed");
  return l.ok ? l.fence : 0;
}

test("T2 append: dense fenced appends, then a dense readback honoring fromSeq", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  assert.deepEqual(await store.append("s", 0, [enc("r0")], f), { ok: true, seq: 0 });
  assert.deepEqual(await store.append("s", 1, [enc("r1")], f), { ok: true, seq: 1 });
  const rows = await store.readJournal("s", 0);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
  assert.deepEqual(rows.map((r) => dec(r.bytes)), ["r0", "r1"]);
  assert.deepEqual((await store.readJournal("s", 1)).map((r) => r.seq), [1]);
});

test("T2 append: a wrong expectedSeq is a seq_conflict carrying the current hwm", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  assert.deepEqual(await store.append("s", 5, [enc("x")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
  assert.deepEqual(await store.append("s", 0, [enc("x")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
});

test("T2 append: a multi-record batch lands densely", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  assert.deepEqual(await store.append("s", 0, [enc("a"), enc("b"), enc("c")], f), {
    ok: true,
    seq: 2,
  });
  assert.deepEqual((await store.readJournal("s", 0)).map((r) => dec(r.bytes)), ["a", "b", "c"]);
});

test("T2 append: an old fence is rejected loudly (stale_fence) — and stale_fence has PRECEDENCE over seq_conflict", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f1 = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f1);
  const f2 = await leaseFence(store, "s");
  assert.ok(f2 > f1, "takeover must raise the fence");
  await store.append("s", 1, [enc("r1")], f2);
  // the superseded host (fence f1) is now stale at the correct next seq
  assert.deepEqual(await store.append("s", 2, [enc("late")], f1), {
    ok: false,
    reason: "stale_fence",
    currentFence: f2,
  });
  // PRECEDENCE: even with a WRONG seq, a stale fence is reported as stale_fence,
  // not seq_conflict (the fs/sqlite reference checks the fence FIRST).
  assert.deepEqual(await store.append("s", 99, [enc("late")], f1), {
    ok: false,
    reason: "stale_fence",
    currentFence: f2,
  });
});

// --- snapshot / hwm / truncate (the migrate-into-edge contract) -------------

test("T2 writeSnapshot SEEDS the hwm — a snapshot at K on an EMPTY journal lets K+1 append densely (migrate-into-edge)", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  await store.writeSnapshot("s", 5, enc("snap@5"));
  const snap = await store.readLatestSnapshot("s");
  assert.deepEqual({ upToSeq: snap?.upToSeq, b: dec(snap!.bytes) }, { upToSeq: 5, b: "snap@5" });
  assert.deepEqual(await store.append("s", 6, [enc("r6")], f), { ok: true, seq: 6 });
  assert.deepEqual(await store.append("s", 8, [enc("r8")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 6,
  });
});

test("T2 truncate: seq numbers are NOT reused after truncation (hwm survives via the snapshot)", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  await store.append("s", 2, [enc("r2")], f);
  await store.writeSnapshot("s", 2, enc("snap@2"));
  await store.truncateJournal("s", 2);
  assert.deepEqual(await store.readJournal("s", 0), [], "truncated rows are gone");
  assert.deepEqual(await store.append("s", 0, [enc("reuse")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 2,
  });
  assert.deepEqual(await store.append("s", 3, [enc("r3")], f), { ok: true, seq: 3 });
});

test("T2 readLatestSnapshot: none → null; multiple → the highest upToSeq", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  assert.equal(await store.readLatestSnapshot("s"), null);
  await store.writeSnapshot("s", 2, enc("a"));
  await store.writeSnapshot("s", 9, enc("b"));
  const snap = await store.readLatestSnapshot("s");
  assert.equal(snap?.upToSeq, 9);
  assert.equal(dec(snap!.bytes), "b");
});

test("T2 hwm: gap-free prefix derivation — a snapshot below a gap does not seed past the gap", async () => {
  // hwm = max(snapshot.upToSeq, gap-free journal prefix). A journal with a gap
  // (0,1 then 3) only counts the gap-free prefix (1); the next dense append is 2.
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  // hwm is 1; the dense next is 2 (a 3 would punch a gap)
  assert.deepEqual(await store.append("s", 3, [enc("r3")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
  assert.deepEqual(await store.append("s", 2, [enc("r2")], f), { ok: true, seq: 2 });
});

// --- cold-isolate invariant: a FRESH instance over the same storage ----------

test("T2 cold-isolate: a brand-new DoStateStore over the same DoStorage sees prior journal + snapshot + lease", async () => {
  const storage = new FakeDoStorage();
  const a = new DoStateStore(storage);
  const f = await leaseFence(a, "s");
  await a.append("s", 0, [enc("r0")], f);
  await a.writeSnapshot("s", 0, enc("snap@0"));
  await a.cas("lease:other", null, enc("lv"));

  // a cold isolate — no shared in-memory state, only the DoStorage
  const b = new DoStateStore(storage);
  assert.equal((await b.readLatestSnapshot("s"))?.upToSeq, 0);
  assert.deepEqual((await b.readJournal("s", 0)).map((r) => dec(r.bytes)), ["r0"]);
  assert.equal(dec((await b.load("lease:other"))!.bytes), "lv");
  // and it continues the SAME fence/seq line densely
  const f2 = await leaseFence(b, "s");
  assert.deepEqual(await b.append("s", 1, [enc("r1")], f2), { ok: true, seq: 1 });
});

// --- key/namespace confinement: prefixes do not bleed across sessions --------

test("T2 namespace: two sessions' journals are independent (prefix-confined)", async () => {
  const store = new DoStateStore(new FakeDoStorage());
  const fa = await leaseFence(store, "sa");
  const fb = await leaseFence(store, "sb");
  await store.append("sa", 0, [enc("a0")], fa);
  await store.append("sb", 0, [enc("b0")], fb);
  assert.deepEqual((await store.readJournal("sa", 0)).map((r) => dec(r.bytes)), ["a0"]);
  assert.deepEqual((await store.readJournal("sb", 0)).map((r) => dec(r.bytes)), ["b0"]);
});
