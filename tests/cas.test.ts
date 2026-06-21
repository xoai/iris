// sqlite-SPECIFIC atomicity. Real multi-writer interleaving is unreachable
// single-threaded, so we prove the BEGIN IMMEDIATE transaction ROLLS BACK on a
// mid-batch failure — no partial rows, fence not bumped. A store missing the
// transaction would leave a partial row behind. (The portable CAS / fencing / hwm
// contract is certified for sqlite in store-sqlite-conformance.test.ts via the
// shared suite; this check needs a store subclass to inject the fault, so it stays
// store-specific.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { openDatabase, SqliteStateStore } from "@irisrun/store-sqlite";

class FaultyStore extends SqliteStateStore {
  callCount = 0;
  faultOnCall = 3;
  protected insertRecord(
    sessionId: string,
    seq: number,
    bytes: Uint8Array,
    fence: Version,
  ): void {
    this.callCount += 1;
    if (this.callCount === this.faultOnCall) {
      throw new Error("injected mid-batch fault");
    }
    super.insertRecord(sessionId, seq, bytes, fence);
  }
}

test("sqlite atomic rollback — mid-batch failure leaves no partial rows and fence unchanged", async () => {
  const store = new FaultyStore(openDatabase(":memory:"));
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const f1: Version = a.ok ? a.version : 0; // 1

  // 1 successful record at seq 0 (insertRecord call #1) → journal_fence = 1
  assert.deepEqual(await store.append("s", 0, [encode({ n: 0 })], f1), {
    ok: true,
    seq: 0,
  });

  // faulty batch under a higher fence: recB inserts (call #2, seq 1), recC throws (call #3)
  const b = await store.cas("lease:s", f1, encode({ h: "B" }));
  const f2: Version = b.ok ? b.version : 0; // 2
  await assert.rejects(
    store.append("s", 1, [encode({ n: 1 }), encode({ n: 2 })], f2),
    /injected mid-batch fault/,
  );

  // rollback undid the seq-1 insert
  const rows = await store.readJournal("s", 0);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0],
    "partial row from the failed batch was not rolled back",
  );

  // fence was NOT bumped to f2: an append with the OLD fence f1 still succeeds
  const probe = await store.append("s", 1, [encode({ n: 99 })], f1);
  assert.deepEqual(probe, { ok: true, seq: 1 });
});
