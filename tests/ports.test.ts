import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "@irisrun/core";
import type { Json } from "@irisrun/core";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";

// Structural-conformance check: the in-memory mocks implement the ports and
// enforce CAS/fencing (they never bypass the checks).
test("ports: MemStateStore cas + fenced append round-trip", async () => {
  const store = new MemStateStore();
  const sid = "s1";

  // lease via cas
  const c1 = await store.cas("lease:s1", null, encode({ holder: "A" }));
  assert.ok(c1.ok);
  const fence = c1.ok ? c1.version : 0;

  // append two records under the fence
  const r = await store.append(
    sid,
    0,
    [encode({ n: 1 } as Json), encode({ n: 2 } as Json)],
    fence,
  );
  assert.deepEqual(r, { ok: true, seq: 1 });

  const rows = await store.readJournal(sid, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(decode(rows[0].bytes), { n: 1 });
  assert.deepEqual(decode(rows[1].bytes), { n: 2 });
});

test("ports: snapshot write/read and truncate", async () => {
  const store = new MemStateStore();
  const sid = "s2";
  const c = await store.cas("lease:s2", null, encode({ holder: "A" }));
  const fence = c.ok ? c.version : 0;
  await store.append(sid, 0, [encode({ n: 1 }), encode({ n: 2 }), encode({ n: 3 })], fence);

  await store.writeSnapshot(sid, 1, encode({ snap: true }));
  const snap = await store.readLatestSnapshot(sid);
  assert.equal(snap?.upToSeq, 1);

  await store.truncateJournal(sid, 1);
  const tail = await store.readJournal(sid, 0);
  assert.deepEqual(
    tail.map((r) => r.seq),
    [2],
  );
});

test("ports: scheduler + logical clock mocks behave", async () => {
  const sched = new MemScheduler();
  await sched.sleepUntil("s3", 100);
  await sched.signal("s3", "approve");
  assert.deepEqual(sched.timers, [{ sessionId: "s3", wakeAt: 100 }]);
  assert.equal(sched.signals[0].name, "approve");

  const clock = new TestClock(10);
  assert.equal(clock.now(), 10);
  clock.advance(5);
  assert.equal(clock.now(), 15);
  clock.set(1000);
  assert.equal(clock.now(), 1000);
});
