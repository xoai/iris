// T3: exportSession/importSession cross-host round-trip. A session exported
// from store A and imported into store B resumes-equivalent to a never-migrated
// control (verifySession parity), records are imported VERBATIM, the §3.0
// truncated-window is handled, and importSession refuses a non-empty
// destination before any write (releasing the lease on every path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseLease } from "@irisrun/core";
import type { StateStore } from "@irisrun/core";
import { MemoryStateStore } from "@irisrun/store-memory";
import { SqliteStateStore, openDatabase } from "@irisrun/store-sqlite";
import { FsStateStore } from "@irisrun/store-fs";
import { exportSession, importSession } from "@irisrun/journal-export";
import { verifySession } from "@irisrun/audit";
import { recordGovernedSession, harnessReducer, harnessInitial } from "./lib/record-governed-session.ts";

const freshStores = (): Array<[string, StateStore]> => [
  ["memory", new MemoryStateStore()],
  ["sqlite", new SqliteStateStore(openDatabase(":memory:"))],
  ["fs", new FsStateStore({ root: mkdtempSync(join(tmpdir(), "iris-jx-")) })],
];

async function bytesAt(store: StateStore, id: string): Promise<string[]> {
  const rows = await store.readJournal(id, 0);
  return rows.map((r) => Buffer.from(r.bytes).toString("base64"));
}

test("round-trip parity: export(A) → import(B) finishes verify-equal to control (no-snapshot)", async () => {
  const src = await recordGovernedSession(); // 24 records, complete, no snapshot
  const x = await exportSession(src, "s");
  const control = await verifySession(src, "s", harnessReducer(), { startState: harnessInitial() });
  assert.equal(control.ok, true);

  for (const [name, dst] of freshStores()) {
    const r = await importSession(dst, x);
    assert.equal(r.records, x.records.length, name);
    // records imported VERBATIM (byte-for-byte the source bytes)
    assert.deepEqual(await bytesAt(dst, "s"), await bytesAt(src, "s"), `${name}: verbatim bytes`);
    const v = await verifySession(dst, "s", harnessReducer(), { startState: harnessInitial() });
    assert.equal(v.ok, true, `${name}: verify ok`);
    assert.equal(v.finalStateDigest, control.finalStateDigest, `${name}: digest parity`);
  }
});

test("truncated window (snapshotThreshold:2): complete:false, range.from===snapUpTo+1, resumes verify-equal", async () => {
  const src = await recordGovernedSession({ snapshotThreshold: 2 });
  const snap = await src.readLatestSnapshot("s");
  assert.ok(snap, "expected a snapshot");
  const x = await exportSession(src, "s");
  assert.equal(x.complete, false);
  assert.equal(x.range?.from, snap.upToSeq + 1);

  const control = await verifySession(src, "s", harnessReducer()); // uses snapshot as start
  assert.equal(control.ok, true);

  const dst = new SqliteStateStore(openDatabase(":memory:"));
  await importSession(dst, x);
  assert.deepEqual(await bytesAt(dst, "s"), await bytesAt(src, "s"), "verbatim bytes");
  const v = await verifySession(dst, "s", harnessReducer());
  assert.equal(v.ok, true); // orphan result in a truncated window is NOT flagged
  assert.equal(v.finalStateDigest, control.finalStateDigest);
});

test("importSession refuses a non-empty destination before any write, and releases the lease", async () => {
  const src = await recordGovernedSession();
  const x = await exportSession(src, "s");
  const dst = new MemoryStateStore();
  await importSession(dst, x); // first import ok
  const before = await bytesAt(dst, "s");

  await assert.rejects(() => importSession(dst, x), /already has session/);
  assert.deepEqual(await bytesAt(dst, "s"), before, "destination unchanged after refusal");

  // lease released on both the success and the refusal path → dest is leasable
  const lease = await acquireLease(dst, "s", "probe");
  assert.equal(lease.ok, true, "destination leasable after import+refusal");
  if (lease.ok) await releaseLease(dst, "s", lease.fence);
});
