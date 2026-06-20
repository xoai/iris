// T1 — FakeDoStorage fixture conformance. The in-suite stand-in
// for Cloudflare's DurableObjectState.storage: an in-memory Map with a REAL
// serialized transaction() (a promise-chain mutex — the DO single-instance
// guarantee) and a settable alarm clock. EVERYTHING in workstream A tests
// against this, so its atomicity is load-bearing: two concurrent transaction()
// calls that both read-then-write the same key must NOT interleave (the
// no-check→await→mutate regression lock, [[lrn-single-use-token-toctou]]).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDoStorage } from "./lib/fake-do.ts";
import type { DoStorage } from "@irisrun/store-do";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

test("T1 fake: get/put/delete round-trip", async () => {
  const s = new FakeDoStorage();
  assert.equal(await s.get("k"), undefined);
  await s.put("k", enc("v"));
  assert.equal(dec((await s.get("k"))!), "v");
  assert.equal(await s.delete("k"), true, "delete reports it removed an existing key");
  assert.equal(await s.delete("k"), false, "delete reports false for an absent key");
  assert.equal(await s.get("k"), undefined);
});

test("T1 fake: list({prefix}) returns only matching keys, in sorted key order", async () => {
  const s = new FakeDoStorage();
  await s.put("j/2", enc("b"));
  await s.put("j/1", enc("a"));
  await s.put("j/10", enc("c"));
  await s.put("other/x", enc("z"));
  const got = await s.list({ prefix: "j/" });
  assert.deepEqual([...got.keys()], ["j/1", "j/10", "j/2"], "prefix-confined + sorted");
  assert.deepEqual([...got.values()].map(dec), ["a", "c", "b"]);
  // no opts → everything
  assert.equal((await s.list()).size, 4);
});

test("T1 fake: transaction() is atomic + serialized — two concurrent read-then-write of the same key do NOT interleave", async () => {
  const s = new FakeDoStorage();
  await s.put("n", enc("0"));

  // Each transaction reads n, yields to the event loop (the await between read
  // and write that a NON-serialized store would let interleave), then writes
  // read+1. Serialized ⇒ the second txn sees the first's committed write ⇒ "2".
  // A check→await→mutate gap would let both read "0" and both write "1".
  const incr = (st: DoStorage): Promise<void> =>
    st.transaction(async (txn) => {
      const cur = Number(dec((await txn.get("n"))!));
      await Promise.resolve(); // a real await between read and write
      await new Promise((r) => setTimeout(r, 0));
      await txn.put("n", enc(String(cur + 1)));
    });

  await Promise.all([incr(s), incr(s)]);
  assert.equal(dec((await s.get("n"))!), "2", "serialized: no lost update");
});

test("T1 fake: transaction() observes writes from a prior committed transaction; the callback's txn handle reads its own writes", async () => {
  const s = new FakeDoStorage();
  // a txn reads its own write back within the same callback
  const seen = await s.transaction(async (txn) => {
    await txn.put("x", enc("inside"));
    return dec((await txn.get("x"))!);
  });
  assert.equal(seen, "inside");
  // and the write is durable after commit
  assert.equal(dec((await s.get("x"))!), "inside");
});

test("T1 fake: transaction() returns the callback's value and propagates throws (without leaving the mutex stuck)", async () => {
  const s = new FakeDoStorage();
  assert.equal(await s.transaction(async () => 42), 42);
  await assert.rejects(
    s.transaction(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // the mutex is released even after a throw — a subsequent txn still runs
  assert.equal(await s.transaction(async () => "ok"), "ok");
});

test("T1 fake: setAlarm/getAlarm persist the EARLIEST scheduled time (and clear)", async () => {
  const s = new FakeDoStorage();
  assert.equal(await s.getAlarm(), null);
  await s.setAlarm(100);
  assert.equal(await s.getAlarm(), 100);
  // a later setAlarm with a SMALLER time lowers it (earliest wins is the caller's
  // job via min(); the raw store just stores what it is given). The fixture stores
  // the last value set — DoScheduler computes the min before calling setAlarm.
  await s.setAlarm(50);
  assert.equal(await s.getAlarm(), 50);
});

test("T1 fake: the alarm clock advances logical time for the resume path", async () => {
  const s = new FakeDoStorage();
  await s.setAlarm(10);
  assert.equal(s.now(), 0, "logical clock starts at 0");
  s.advanceTo(10);
  assert.equal(s.now(), 10);
  // advancing does not auto-clear the alarm; the scheduler/host clears it on confirm
  assert.equal(await s.getAlarm(), 10);
});
