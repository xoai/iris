import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

// @irisrun/store-memory enforces the SAME invariants as SQLite (CAS, fencing, hwm).

test("memory-store: cas — two writers with same expected, one wins", async () => {
  const s = new MemoryStateStore();
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  assert.ok(a.ok && a.version === 1);
  const b = await s.cas("lease:s", null, encode({ h: "B" }));
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.current, 1);
});

test("memory-store: append rejects stale fence and seq gaps", async () => {
  const s = new MemoryStateStore();
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  const f1: Version = a.ok ? a.version : 0;
  await s.append("s", 0, [encode({ n: 0 })], f1);
  // takeover
  const b = await s.cas("lease:s", f1, encode({ h: "B" }));
  const f2: Version = b.ok ? b.version : 0;
  await s.append("s", 1, [encode({ n: 1 })], f2); // B writes → fence bumps to f2
  const stale = await s.append("s", 2, [encode({ n: 2 })], f1);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "stale_fence");
  const gap = await s.append("s", 9, [encode({ n: 9 })], f2);
  assert.equal(gap.ok, false);
  if (!gap.ok) assert.equal(gap.reason, "seq_conflict");
});

test("memory-store: seq numbers are NOT reused after truncation (hwm)", async () => {
  const s = new MemoryStateStore();
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 }), encode({ n: 2 })], f);
  await s.writeSnapshot("s", 2, encode({ snap: true }));
  await s.truncateJournal("s", 2);
  assert.deepEqual(await s.readJournal("s", 0), []);
  for (const reused of [0, 1, 2]) {
    const r = await s.append("s", reused, [encode({ n: reused })], f);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "seq_conflict");
  }
  assert.deepEqual(await s.append("s", 3, [encode({ n: 3 })], f), {
    ok: true,
    seq: 3,
  });
});

test("memory-store: readback is dense and decodes", async () => {
  const s = new MemoryStateStore();
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 })], f);
  const rows = await s.readJournal("s", 0);
  assert.deepEqual(rows.map((r) => decode(r.bytes)), [{ n: 0 }, { n: 1 }]);
});

test("memory-scheduler: dueWakeups peeks, confirmWoken consumes", async () => {
  const sched = new MemoryScheduler();
  await sched.sleepUntil("s", 10);
  assert.deepEqual(sched.dueWakeups(5), []);
  assert.deepEqual(sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  assert.deepEqual(sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]); // peek again
  sched.confirmWoken("s", 20);
  assert.deepEqual(sched.dueWakeups(20), []);
});
