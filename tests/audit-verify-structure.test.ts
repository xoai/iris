// T1: verifyStructure is the reducer-free structural core extracted from
// verifyReplay. It checks dense/monotonic seq, self-seq vs row position,
// ≤1 result per effectId, and (only when complete) intent-join — WITHOUT a
// reducer or any replay. The existing audit-verify.test.ts is the regression
// gate that verifyReplay's behavior is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStructure } from "@irisrun/audit";
import type { JournalRecord } from "@irisrun/core";

const D = "sha256:def";
function intent(seq: number, effectId: string): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: D,
    kind: "effect_intent",
    payload: { effectId, effectKind: "echo", request: null, retrySafe: true },
  };
}
function result(seq: number, effectId: string): JournalRecord {
  return {
    seq,
    ts: 0,
    defDigest: D,
    kind: "effect_result",
    payload: { effectId, outcome: { ok: true, value: null } },
  };
}

test("dense, well-formed records → ok, no issues", () => {
  const recs = [intent(0, "e0"), result(1, "e0"), intent(2, "e1"), result(3, "e1")];
  const r = verifyStructure(recs, { complete: true, rowSeqs: [0, 1, 2, 3] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.complete, true);
});

test("non-dense seq → flagged", () => {
  const recs = [intent(0, "e0"), result(2, "e0")]; // gap 0 → 2
  const r = verifyStructure(recs);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("not dense")));
});

test("self-seq mismatch vs row position → flagged", () => {
  const recs = [intent(0, "e0"), result(1, "e0")];
  const r = verifyStructure(recs, { rowSeqs: [0, 5] }); // row 1 stored at position 5
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("self-seq mismatch")));
});

test("duplicate effect_result for one effectId → flagged", () => {
  const recs = [intent(0, "e0"), result(1, "e0"), result(2, "e0")];
  const r = verifyStructure(recs, { complete: true });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("duplicate effect_result")));
});

test("orphan result is flagged when complete", () => {
  const recs = [result(0, "orphan")]; // no prior intent
  const r = verifyStructure(recs, { complete: true });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("no prior effect_intent")));
});

test("orphan result is NOT flagged when incomplete (truncated window)", () => {
  const recs = [result(0, "orphan")];
  const r = verifyStructure(recs, { complete: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.complete, false);
});

test("complete defaults to true when omitted", () => {
  const r = verifyStructure([result(0, "orphan")]);
  assert.equal(r.complete, true);
  assert.equal(r.ok, false);
});
