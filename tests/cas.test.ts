import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "@iris/core";
import type { Version } from "@iris/core";
import { openDatabase, SqliteStateStore } from "@iris/store-sqlite";

// A2 — CAS correctness + monotonic fencing on the REAL SQLite store.

test("A2: cas — two writers with the same expected, exactly one wins", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  // concurrent create (both expected=null) — run sequentially (single-threaded)
  const c1 = await store.cas("lease:s", null, encode({ h: "A" }));
  assert.ok(c1.ok && c1.version === 1);
  const c2 = await store.cas("lease:s", null, encode({ h: "B" }));
  assert.equal(c2.ok, false);
  if (!c2.ok) assert.equal(c2.current, 1);

  // concurrent update (both expected=1) — first wins
  const u1 = await store.cas("lease:s", 1, encode({ h: "A2" }));
  assert.ok(u1.ok && u1.version === 2);
  const u2 = await store.cas("lease:s", 1, encode({ h: "B2" }));
  assert.equal(u2.ok, false);
  if (!u2.ok) assert.equal(u2.current, 2);
});

test("A2: append rejects a stale (lower) fence even when expectedSeq is correct", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const fenceA: Version = a.ok ? a.version : 0; // 1
  assert.deepEqual(await store.append("s", 0, [encode({ n: 0 })], fenceA), {
    ok: true,
    seq: 0,
  });

  // takeover → strictly higher fence
  const b = await store.cas("lease:s", fenceA, encode({ h: "B" }));
  const fenceB: Version = b.ok ? b.version : 0; // 2
  assert.ok(fenceB > fenceA);
  assert.deepEqual(await store.append("s", 1, [encode({ n: 1 })], fenceB), {
    ok: true,
    seq: 1,
  });

  // old holder, correct seq (2), STALE fence (1) → rejected
  const stale = await store.append("s", 2, [encode({ n: 2 })], fenceA);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.reason, "stale_fence");
    assert.equal(stale.currentFence, fenceB);
  }
});

test("A2: append rejects a seq gap (journal stays dense)", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  await store.append("s", 0, [encode({ n: 0 })], f);
  const gap = await store.append("s", 5, [encode({ n: 5 })], f);
  assert.equal(gap.ok, false);
  if (!gap.ok) {
    assert.equal(gap.reason, "seq_conflict");
    assert.equal(gap.currentSeq, 0);
  }
});

test("A2: happy-path append is dense and reads back in order", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  await store.append("s", 0, [encode({ n: 0 }), encode({ n: 1 })], f);
  await store.append("s", 2, [encode({ n: 2 })], f);
  const rows = await store.readJournal("s", 0);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    rows.map((r) => decode(r.bytes)),
    [{ n: 0 }, { n: 1 }, { n: 2 }],
  );
});

test("A2: seq numbers are NOT reused after truncation (high-water mark)", async () => {
  const store = new SqliteStateStore(openDatabase(":memory:"));
  const a = await store.cas("lease:s", null, encode({ h: "A" }));
  const f: Version = a.ok ? a.version : 0;
  // append seq 0,1,2 then snapshot@2 and truncate the prefix
  await store.append("s", 0, [encode({ n: 0 }), encode({ n: 1 }), encode({ n: 2 })], f);
  await store.writeSnapshot("s", 2, encode({ snap: true }));
  await store.truncateJournal("s", 2);
  assert.deepEqual(await store.readJournal("s", 0), []); // rows gone

  // re-appending at an already-used (now truncated) seq must be rejected:
  // the high-water mark is 2, so expectedSeq 0 / 1 / 2 all conflict.
  for (const reused of [0, 1, 2]) {
    const r = await store.append("s", reused, [encode({ n: reused })], f);
    assert.equal(r.ok, false, `seq ${reused} must not be reusable`);
    if (!r.ok) {
      assert.equal(r.reason, "seq_conflict");
      assert.equal(r.currentSeq, 2);
    }
  }
  // the next dense seq (3) is accepted
  assert.deepEqual(await store.append("s", 3, [encode({ n: 3 })], f), {
    ok: true,
    seq: 3,
  });
});

// Atomicity proxy: real multi-writer interleaving is unreachable single-threaded,
// so we prove the BEGIN IMMEDIATE transaction ROLLS BACK on a mid-batch failure —
// no partial rows, fence not bumped. A store missing the transaction would leave
// a partial row behind.
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

test("A2: atomic rollback — mid-batch failure leaves no partial rows and fence unchanged", async () => {
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
