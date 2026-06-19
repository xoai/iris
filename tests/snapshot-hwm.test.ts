import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "@iris/core";
import type { Version } from "@iris/core";
import { openDatabase, SqliteStateStore } from "@iris/store-sqlite";

// Task 2: writeSnapshot seeds the high-water mark (spec §3.4).

test("snapshot-hwm: normal-op (upToSeq == hwm) is a no-op — append continues densely", async () => {
  const s = new SqliteStateStore(openDatabase(":memory:"));
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  await s.append("s", 0, [encode({ n: 0 }), encode({ n: 1 })], f); // hwm = 1
  await s.writeSnapshot("s", 1, encode({ snap: true })); // upToSeq == hwm == 1 → no-op
  // appending continues densely at seq 2 (tweak did not disturb the cursor)
  assert.deepEqual(await s.append("s", 2, [encode({ n: 2 })], f), {
    ok: true,
    seq: 2,
  });
});

test("snapshot-hwm: seeding (upToSeq > hwm) lets a migrated tail append at upToSeq+1", async () => {
  const s = new SqliteStateStore(openDatabase(":memory:"));
  const a = await s.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  // empty journal; seed a snapshot at seq 5 (the migration case)
  await s.writeSnapshot("s", 5, encode({ migrated: true }));
  // the migrated tail starts at seq 6 — must pass the density check now
  assert.deepEqual(await s.append("s", 6, [encode({ n: 6 })], f), {
    ok: true,
    seq: 6,
  });
  // and seq 5 (already covered by the snapshot) cannot be (re)used
  const reuse = await s.append("s", 5, [encode({ n: 5 })], f);
  assert.equal(reuse.ok, false);
});
