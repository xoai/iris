import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireLease, encode } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { openDatabase, SqliteStateStore } from "@irisrun/store-sqlite";

test("lease: first acquire returns a fence", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const r = await acquireLease(store, "s", "A");
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.fence >= 1);
});

test("lease: takeover yields a strictly higher fence, old fence is then fenced out", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const a = await acquireLease(store, "s", "A");
  const fenceA: Version = a.ok ? a.fence : 0;
  // A writes seq 0 under fenceA
  assert.deepEqual(await store.append("s", 0, [encode({ n: 0 })], fenceA), {
    ok: true,
    seq: 0,
  });

  // B takes over → strictly higher fence
  const b = await acquireLease(store, "s", "B");
  const fenceB: Version = b.ok ? b.fence : 0;
  assert.ok(fenceB > fenceA);

  // B writes first under its fence → bumps the stored fence to fenceB.
  // (Fencing protects the journal once the new holder writes; lease takeover
  // alone doesn't retroactively invalidate an old holder until then.)
  assert.deepEqual(await store.append("s", 1, [encode({ n: 1 })], fenceB), {
    ok: true,
    seq: 1,
  });

  // A (old holder) now tries to append under its stale fence → rejected
  const stale = await store.append("s", 2, [encode({ n: 2 })], fenceA);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "stale_fence");
});

test("lease: concurrent acquire — two writers see the same prior version, one wins", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  // both observe "no lease yet" (expected=null)
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const b = await store.cas("lease:s", null, encode({ h: "B" }));
  assert.ok(a.ok);
  assert.equal(b.ok, false); // race loser
});
