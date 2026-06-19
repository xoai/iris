// T1 (M-Proof) — @iris/store-fs FsStateStore conformance. The fs store is host B
// (serverless cold-per-turn over node:fs); it MUST enforce the SAME invariants the
// sqlite/memory stores enforce: true CAS (O_EXCL), fenced+dense append, an hwm that
// survives truncation, writeSnapshot-seeds-hwm (the migrate-into-fs contract), and
// key→filename encoding confined to the root (no path traversal). No determinism
// bypass. Same conformance shape as store-memory.test.ts / ports.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease } from "@iris/core";
import type { Version } from "@iris/core";
import { FsStateStore, FsScheduler } from "@iris/store-fs";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "iris-fs-"));
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// --- CAS (the lease rides this) ---------------------------------------------

test("T1 cas: first write (expected=null) → {ok,version:1}; a second null-cas loses with current:1", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const r1 = await store.cas("lease:s", null, enc("a"));
  assert.deepEqual(r1, { ok: true, version: 1 });
  // a second acquirer that also expects null (the first-acquire race) loses
  const r2 = await store.cas("lease:s", null, enc("b"));
  assert.deepEqual(r2, { ok: false, current: 1 });
  // and the value/version are readable back
  const got = await store.load("lease:s");
  assert.equal(got?.version, 1);
  assert.equal(dec(got!.bytes), "a");
});

test("T1 cas: versioned CAS advances, and a stale expected loses with the real current", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  assert.deepEqual(await store.cas("k", null, enc("v1")), { ok: true, version: 1 });
  assert.deepEqual(await store.cas("k", 1, enc("v2")), { ok: true, version: 2 });
  // expected=1 is now stale (current is 2)
  assert.deepEqual(await store.cas("k", 1, enc("v3")), { ok: false, current: 2 });
  assert.equal(dec((await store.load("k"))!.bytes), "v2");
});

test("T1 load: a missing key is null", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  assert.equal(await store.load("nope"), null);
});

// --- append: dense, fenced, seq_conflict, stale_fence -----------------------

async function leaseFence(store: FsStateStore, sid: string): Promise<Version> {
  const l = await acquireLease(store, sid, "H");
  assert.ok(l.ok, "lease acquire failed");
  return l.ok ? l.fence : 0;
}

test("T1 append: dense fenced appends, then a dense readback", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  assert.deepEqual(await store.append("s", 0, [enc("r0")], f), { ok: true, seq: 0 });
  assert.deepEqual(await store.append("s", 1, [enc("r1")], f), { ok: true, seq: 1 });
  const rows = await store.readJournal("s", 0);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
  assert.deepEqual(rows.map((r) => dec(r.bytes)), ["r0", "r1"]);
  // readJournal honors fromSeq
  assert.deepEqual((await store.readJournal("s", 1)).map((r) => r.seq), [1]);
});

test("T1 append: a wrong expectedSeq is a seq_conflict carrying the current hwm", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  // hwm is 1; an append at 5 must not punch a gap
  assert.deepEqual(await store.append("s", 5, [enc("x")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
  // re-asserting the SAME seq (0) when hwm=1 also conflicts
  assert.deepEqual(await store.append("s", 0, [enc("x")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
});

test("T1 append: an old fence is rejected loudly (stale_fence)", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  // host A takes the lease (fence 1) and appends
  const f1 = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f1);
  // host B takes over (fence 2) and appends
  const f2 = await leaseFence(store, "s");
  assert.ok(f2 > f1, "takeover must raise the fence");
  await store.append("s", 1, [enc("r1")], f2);
  // the superseded host A (fence 1) is now stale
  assert.deepEqual(await store.append("s", 2, [enc("late")], f1), {
    ok: false,
    reason: "stale_fence",
    currentFence: f2,
  });
});

// --- snapshot / hwm / truncate (the migrate-into-fs contract) ---------------

test("T1 writeSnapshot SEEDS the hwm — a snapshot at K on an EMPTY journal lets K+1 append densely (migrate-into-fs)", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  // migrate seeds a truncated source: snapshot at upToSeq=5, journal empty
  await store.writeSnapshot("s", 5, enc("snap@5"));
  const snap = await store.readLatestSnapshot("s");
  assert.deepEqual({ upToSeq: snap?.upToSeq, b: dec(snap!.bytes) }, { upToSeq: 5, b: "snap@5" });
  // the migrated tail starts at 6 and MUST satisfy the density check (hwm seeded to 5)
  assert.deepEqual(await store.append("s", 6, [enc("r6")], f), { ok: true, seq: 6 });
  // a gap (8) is still rejected
  assert.deepEqual(await store.append("s", 8, [enc("r8")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 6,
  });
});

test("T1 truncate: seq numbers are NOT reused after truncation (hwm survives via the snapshot)", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  await store.append("s", 2, [enc("r2")], f);
  await store.writeSnapshot("s", 2, enc("snap@2"));
  await store.truncateJournal("s", 2);
  assert.deepEqual(await store.readJournal("s", 0), [], "truncated rows are gone");
  // hwm is still 2 (from the snapshot) — the next append is 3, not a reused 0
  assert.deepEqual(await store.append("s", 0, [enc("reuse")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 2,
  });
  assert.deepEqual(await store.append("s", 3, [enc("r3")], f), { ok: true, seq: 3 });
});

test("T1 readLatestSnapshot: none → null; multiple → the highest upToSeq", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  assert.equal(await store.readLatestSnapshot("s"), null);
  await store.writeSnapshot("s", 2, enc("a"));
  await store.writeSnapshot("s", 9, enc("b"));
  const snap = await store.readLatestSnapshot("s");
  assert.equal(snap?.upToSeq, 9);
  assert.equal(dec(snap!.bytes), "b");
});

// --- key encoding + root confinement ----------------------------------------

test("T1 key encoding: a key with ':' and '/' is encoded and confined under the root", async () => {
  const root = freshRoot();
  const store = new FsStateStore({ root });
  // the real lease key shape plus separators that must NOT become path parts
  const r = await store.cas("lease:tenant/abc:1", null, enc("v"));
  assert.deepEqual(r, { ok: true, version: 1 });
  assert.equal(dec((await store.load("lease:tenant/abc:1"))!.bytes), "v");
  // nothing escaped the root: no stray dirs above the kv subtree
  const top = await readdir(root);
  assert.ok(top.includes("kv"), "kv subtree exists under the root");
  // the raw separators did not create nested dirs (encoded to a single segment)
  assert.equal(existsSync(join(root, "kv", "lease:tenant")), false);
  assert.equal(existsSync(join(root, "kv", "lease:tenant", "abc:1")), false);
});

test("T1 key encoding: a traversal-shaped key is neutralized — it stays under the root (no escape)", async () => {
  const root = freshRoot();
  const store = new FsStateStore({ root });
  // a key that LOOKS like a traversal: '/' is encoded, so it can never become a
  // real path separator — it collapses to one confined filename segment.
  const r = await store.cas("../../escape", null, enc("x"));
  assert.deepEqual(r, { ok: true, version: 1 });
  assert.equal(dec((await store.load("../../escape"))!.bytes), "x");
  // nothing was written OUTSIDE the root (the parent dir gained no 'escape' file)
  assert.equal(existsSync(join(root, "..", "escape")), false);
  // the single encoded segment lives under kv/ — no nested traversal dirs
  const kvEntries = await readdir(join(root, "kv"));
  assert.equal(kvEntries.length, 1, "exactly one encoded key segment under kv/");
  assert.equal(kvEntries[0].includes("/"), false, "the segment carries no real separator");
});

// --- multi-record batch is all-or-nothing -----------------------------------

test("T1 batch: a clean multi-record append lands densely", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  assert.deepEqual(await store.append("s", 0, [enc("a"), enc("b"), enc("c")], f), {
    ok: true,
    seq: 2,
  });
  assert.deepEqual((await store.readJournal("s", 0)).map((r) => dec(r.bytes)), ["a", "b", "c"]);
});

test("T1 batch: a conflicting batch is all-or-nothing (a pre-occupied seq rolls the batch back)", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f); // hwm=0
  // out-of-band, occupy seq 2 (simulate a racing writer that won seq 2)
  await store.forceAppendRaw("s", 2, enc("intruder"), f);
  // a batch [1,2,3] collides at 2 → NONE of 1/3 may persist (all-or-nothing)
  const res = await store.append("s", 1, [enc("x1"), enc("x2"), enc("x3")], f);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false ? res.reason : "", "seq_conflict");
  // only r0 (seq 0) and the intruder (seq 2) exist — seq 1 and 3 were rolled back
  const seqs = (await store.readJournal("s", 0)).map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [0, 2], "the partial batch left no committed records");
});

// --- serverless invariant: a FRESH instance over the same root sees prior state

test("T1 serverless: a brand-new FsStateStore over the same root sees prior journal + snapshot", async () => {
  const root = freshRoot();
  const a = new FsStateStore({ root });
  const f = await leaseFence(a, "s");
  await a.append("s", 0, [enc("r0")], f);
  await a.writeSnapshot("s", 0, enc("snap@0"));
  // a cold instance — no shared in-memory state
  const b = new FsStateStore({ root });
  assert.equal((await b.readLatestSnapshot("s"))?.upToSeq, 0);
  assert.deepEqual((await b.readJournal("s", 0)).map((r) => dec(r.bytes)), ["r0"]);
  // and it continues the SAME fence/seq line densely
  const f2 = await leaseFence(b, "s");
  assert.deepEqual(await b.append("s", 1, [enc("r1")], f2), { ok: true, seq: 1 });
});

// --- FsScheduler conformance (Task 3) ---------------------------------------
// Mirrors scheduler.test.ts (the sqlite/memory reference): dueWakeups PEEKS,
// confirmWoken consumes; plus the serverless property — durable across instances.

test("T3-sched: a timer is not due before its wake time", async () => {
  const sched = new FsScheduler({ root: freshRoot() });
  await sched.sleepUntil("s", 10);
  assert.deepEqual(await sched.dueWakeups(5), []);
});

test("T3-sched: dueWakeups PEEKS (at-least-once) until confirmWoken consumes", async () => {
  const sched = new FsScheduler({ root: freshRoot() });
  await sched.sleepUntil("s", 10);
  assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  await sched.confirmWoken("s", 20);
  assert.deepEqual(await sched.dueWakeups(20), []);
});

test("T3-sched: a signal round-trips (signal → waitForSignal no-op → peek → consume)", async () => {
  const sched = new FsScheduler({ root: freshRoot() });
  await sched.signal("s", "approve");
  await sched.waitForSignal("s", "approve"); // no-op: must not throw or drop the signal
  assert.deepEqual(await sched.dueWakeups(0), [
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  await sched.confirmWoken("s", 0);
  assert.deepEqual(await sched.dueWakeups(0), []);
});

test("T3-sched: state is DURABLE across a fresh instance (file-backed, no held process)", async () => {
  const root = freshRoot();
  const a = new FsScheduler({ root });
  await a.sleepUntil("s", 10);
  await a.signal("s", "approve");
  // a brand-new instance over the same root — no shared memory
  const b = new FsScheduler({ root });
  assert.deepEqual(await b.dueWakeups(20), [
    { sessionId: "s", kind: "timer" },
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  // and confirming on a fresh instance is also durable
  await b.confirmWoken("s", 20);
  const c = new FsScheduler({ root });
  assert.deepEqual(await c.dueWakeups(20), []);
});
