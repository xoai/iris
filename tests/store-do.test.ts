// @irisrun/store-do (edge / Cloudflare Durable Objects) certified against the
// shared store conformance suite, PLUS the do-specific behaviours the portable
// contract does not cover: the gap-free-prefix hwm derivation (an internal detail)
// and the cold-isolate property (a fresh DoStateStore over the same DoStorage reads
// identical state). Port-contract assertions moved into the suite (M1 mapping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireLease } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { runStoreConformance, register } from "@irisrun/store-conformance";
import { DoStateStore } from "@irisrun/store-do";
import { FakeDoStorage } from "./lib/fake-do.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// --- shared port contract (FakeDoStorage's transaction() serializes writers, so
//     the opt-in concurrency stress confirms exactly-one-winner atomicity) ------
register(runStoreConformance(() => new DoStateStore(new FakeDoStorage()), { concurrency: 8 }), test);

async function leaseFence(store: DoStateStore, sid: string): Promise<Version> {
  const l = await acquireLease(store, sid, "H");
  assert.ok(l.ok, "lease acquire failed");
  return l.ok ? l.fence : 0;
}

// --- do-specific: gap-free prefix hwm derivation ----------------------------

test("do hwm: gap-free prefix derivation — a snapshot below a gap does not seed past the gap", async () => {
  // hwm = max(snapshot.upToSeq, gap-free journal prefix). A journal with a gap
  // (0,1 then 3) only counts the gap-free prefix (1); the next dense append is 2.
  const store = new DoStateStore(new FakeDoStorage());
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f);
  await store.append("s", 1, [enc("r1")], f);
  assert.deepEqual(await store.append("s", 3, [enc("r3")], f), {
    ok: false,
    reason: "seq_conflict",
    currentSeq: 1,
  });
  assert.deepEqual(await store.append("s", 2, [enc("r2")], f), { ok: true, seq: 2 });
});

// --- do-specific: cold-isolate durability -----------------------------------

test("do cold-isolate: a brand-new DoStateStore over the same DoStorage sees prior journal + snapshot + lease", async () => {
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
  const f2 = await leaseFence(b, "s");
  assert.deepEqual(await b.append("s", 1, [enc("r1")], f2), { ok: true, seq: 1 });
});
