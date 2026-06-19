import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateSession, acquireLease, encode, decode } from "@iris/core";
import type { Version } from "@iris/core";
import { MemoryStateStore } from "@iris/store-memory";

// Task 3 unit: migrateSession copies snapshot + journal tail faithfully,
// including across a snapshot boundary (the hwm-seeding case).
test("migrate: copies snapshot + truncated tail across a snapshot boundary", async () => {
  const a = new MemoryStateStore();
  const lease = await acquireLease(a, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  // build A: records 0..5, snapshot @2, truncate ≤2  → A has snap@2 + [3,4,5]
  await a.append(
    "s",
    0,
    [0, 1, 2, 3, 4, 5].map((n) => encode({ n })),
    fence,
  );
  await a.writeSnapshot("s", 2, encode({ upTo: 2 }));
  await a.truncateJournal("s", 2);
  assert.deepEqual(
    (await a.readJournal("s", 0)).map((r) => r.seq),
    [3, 4, 5],
  );

  const b = new MemoryStateStore();
  const result = await migrateSession(a, b, "s");
  assert.deepEqual(result, { records: 3, snapshotUpTo: 2 });

  // B has the same snapshot and the same tail (seqs + bytes)
  const snapB = await b.readLatestSnapshot("s");
  assert.equal(snapB?.upToSeq, 2);
  assert.deepEqual(decode(snapB!.bytes), { upTo: 2 });
  const tailB = await b.readJournal("s", 0);
  assert.deepEqual(tailB.map((r) => r.seq), [3, 4, 5]);
  assert.deepEqual(tailB.map((r) => decode(r.bytes)), [{ n: 3 }, { n: 4 }, { n: 5 }]);

  // B's hwm is seeded so a further append continues densely at seq 6
  const bLease = await acquireLease(b, "s", "post");
  const bFence: Version = bLease.ok ? bLease.fence : 0;
  assert.deepEqual(await b.append("s", 6, [encode({ n: 6 })], bFence), {
    ok: true,
    seq: 6,
  });
});

test("migrate: no-snapshot session copies the whole journal", async () => {
  const a = new MemoryStateStore();
  const lease = await acquireLease(a, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  await a.append("s", 0, [encode({ n: 0 }), encode({ n: 1 })], fence);

  const b = new MemoryStateStore();
  const result = await migrateSession(a, b, "s");
  assert.deepEqual(result, { records: 2, snapshotUpTo: null });
  assert.deepEqual(
    (await b.readJournal("s", 0)).map((r) => decode(r.bytes)),
    [{ n: 0 }, { n: 1 }],
  );
});
