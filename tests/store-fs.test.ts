// @irisrun/store-fs certified against the shared conformance suite
// (@irisrun/store-conformance), PLUS the fs-specific behaviours the portable port
// contract does not cover: key→filename encoding + root confinement (no path
// traversal), mid-batch collision rollback (via the forceAppendRaw test hook), and
// the serverless cold-instance / cold-scheduler durability (a fresh instance over
// the same root sees prior state). The port-contract assertions moved into the
// suite 1:1 (the M1 mapping table) — no coverage dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease } from "@irisrun/core";
import type { Version } from "@irisrun/core";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "iris-fs-"));
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// --- shared port contract (the same suite memory/sqlite/do run) -------------
register(runStoreConformance(() => new FsStateStore({ root: freshRoot() }), { concurrency: 8 }), test);
register(runSchedulerConformance(() => new FsScheduler({ root: freshRoot() })), test);

// --- fs-specific: key encoding + root confinement ---------------------------

async function leaseFence(store: FsStateStore, sid: string): Promise<Version> {
  const l = await acquireLease(store, sid, "H");
  assert.ok(l.ok, "lease acquire failed");
  return l.ok ? l.fence : 0;
}

test("fs key encoding: a key with ':' and '/' is encoded and confined under the root", async () => {
  const root = freshRoot();
  const store = new FsStateStore({ root });
  const r = await store.cas("lease:tenant/abc:1", null, enc("v"));
  assert.deepEqual(r, { ok: true, version: 1 });
  assert.equal(dec((await store.load("lease:tenant/abc:1"))!.bytes), "v");
  const top = await readdir(root);
  assert.ok(top.includes("kv"), "kv subtree exists under the root");
  assert.equal(existsSync(join(root, "kv", "lease:tenant")), false);
  assert.equal(existsSync(join(root, "kv", "lease:tenant", "abc:1")), false);
});

test("fs key encoding: a traversal-shaped key is neutralized — it stays under the root (no escape)", async () => {
  const root = freshRoot();
  const store = new FsStateStore({ root });
  const r = await store.cas("../../escape", null, enc("x"));
  assert.deepEqual(r, { ok: true, version: 1 });
  assert.equal(dec((await store.load("../../escape"))!.bytes), "x");
  assert.equal(existsSync(join(root, "..", "escape")), false);
  const kvEntries = await readdir(join(root, "kv"));
  assert.equal(kvEntries.length, 1, "exactly one encoded key segment under kv/");
  assert.equal(kvEntries[0].includes("/"), false, "the segment carries no real separator");
});

// --- fs-specific: mid-batch collision rollback (needs the forceAppendRaw hook) ---

test("fs batch: a conflicting batch is all-or-nothing (a pre-occupied seq rolls the batch back)", async () => {
  const store = new FsStateStore({ root: freshRoot() });
  const f = await leaseFence(store, "s");
  await store.append("s", 0, [enc("r0")], f); // hwm=0
  // out-of-band, occupy seq 2 (simulate a racing writer that won seq 2)
  await store.forceAppendRaw("s", 2, enc("intruder"), f);
  // a batch [1,2,3] collides at 2 → NONE of 1/3 may persist (all-or-nothing)
  const res = await store.append("s", 1, [enc("x1"), enc("x2"), enc("x3")], f);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false ? res.reason : "", "seq_conflict");
  const seqs = (await store.readJournal("s", 0)).map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [0, 2], "the partial batch left no committed records");
});

// --- fs-specific: serverless cold-instance durability -----------------------

test("fs serverless: a brand-new FsStateStore over the same root sees prior journal + snapshot", async () => {
  const root = freshRoot();
  const a = new FsStateStore({ root });
  const f = await leaseFence(a, "s");
  await a.append("s", 0, [enc("r0")], f);
  await a.writeSnapshot("s", 0, enc("snap@0"));
  const b = new FsStateStore({ root });
  assert.equal((await b.readLatestSnapshot("s"))?.upToSeq, 0);
  assert.deepEqual((await b.readJournal("s", 0)).map((r) => dec(r.bytes)), ["r0"]);
  const f2 = await leaseFence(b, "s");
  assert.deepEqual(await b.append("s", 1, [enc("r1")], f2), { ok: true, seq: 1 });
});

test("fs scheduler: state is DURABLE across a fresh instance (file-backed, no held process)", async () => {
  const root = freshRoot();
  const a = new FsScheduler({ root });
  await a.sleepUntil("s", 10);
  await a.signal("s", "approve");
  const b = new FsScheduler({ root });
  assert.deepEqual(await b.dueWakeups(20), [
    { sessionId: "s", kind: "timer" },
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  await b.confirmWoken("s", 20);
  const c = new FsScheduler({ root });
  assert.deepEqual(await c.dueWakeups(20), []);
});
