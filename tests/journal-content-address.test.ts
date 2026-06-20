// T2: content-addressing (spec §3.1). Authoritative recompute from raw bytes;
// tamper-evidence; frozen cross-language reproducibility vectors; encode/decode
// identity. The digests are recomputed from bytesB64 and never trusted from the
// stored per-record/snapshot `hash` fields (those are diagnostic only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "@irisrun/core";
import {
  buildExport,
  encodeExport,
  decodeExport,
  recomputeFromExport,
  sha256Hex,
} from "@irisrun/journal-export";
import type { JournalExportV1 } from "@irisrun/journal-export";

const IMG = "sha256:img";
const snapBytes = () => encode({ phase: "await_model", n: 1 });
const rec = (seq: number, effectId: string, kind: "effect_intent" | "effect_result") =>
  encode(
    kind === "effect_intent"
      ? { seq, ts: 0, defDigest: IMG, kind, payload: { effectId, effectKind: "model_call", request: { messages: [] }, retrySafe: true } }
      : { seq, ts: 0, defDigest: IMG, kind, payload: { effectId, outcome: { ok: true, value: { role: "assistant", content: "hi" } } } },
  );

function fixedMulti(): JournalExportV1 {
  return buildExport({
    sessionId: "vector-session",
    defDigest: IMG,
    complete: false,
    snapshot: { upToSeq: 1, bytes: snapBytes() },
    records: [
      { seq: 2, bytes: rec(2, "e2", "effect_intent") },
      { seq: 3, bytes: rec(3, "e2", "effect_result") },
    ],
  });
}
const clone = (x: JournalExportV1): JournalExportV1 => decodeExport(encodeExport(x));

test("buildExport is deterministic", () => {
  assert.equal(fixedMulti().contentDigest, fixedMulti().contentDigest);
});

test("recompute from raw bytes matches embedded digests", () => {
  const x = fixedMulti();
  const r = recomputeFromExport(x);
  assert.equal(r.contentDigest, x.contentDigest);
  assert.equal(r.chainHash, x.chainHash);
  assert.deepEqual(r.recordHashes, x.records.map((rr) => rr.hash));
  assert.equal(r.snapshotHash, x.snapshot!.hash);
});

test("FROZEN reproducibility vector — multi-record (cross-language anchor)", () => {
  const x = fixedMulti();
  // The exact canonical preimage string (sorted keys, integer numbers) — the
  // human-checkable anchor a second-language implementer reproduces.
  const preimage =
    '{"algorithm":"sha256/iris-journal-v1","chainHash":"4e43dd61f898666cc4a21f13b4732fc80fdb94b8591d27ee63a60c67e23904af","complete":false,"defDigest":"sha256:img","format":"iris-journal-export","range":{"from":2,"to":3},"recordCount":2,"sessionId":"vector-session","snapshot":{"hash":"ce1dc82a2f5111e02223e131ec9aceb01ded96f6804efa5c618f71bf3cad66af","upToSeq":1},"version":1}';
  assert.equal(recomputeFromExport(x).preimage, preimage);
  assert.equal(x.contentDigest, sha256Hex(preimage));
  assert.equal(x.contentDigest, "2a8a87e5076f09ef02622b2b3edcd496dc6650661642c55b8c52d8df514abea2");
  assert.equal(x.chainHash, "4e43dd61f898666cc4a21f13b4732fc80fdb94b8591d27ee63a60c67e23904af");
});

test("FROZEN reproducibility vector — snapshot-only / 0 records", () => {
  const zero = buildExport({ sessionId: "vector-session", defDigest: "", complete: false, snapshot: { upToSeq: 5, bytes: snapBytes() }, records: [] });
  assert.equal(zero.range, null);
  assert.equal(zero.contentDigest, "b3abfedd162f1d96edba634217c094b5d2a56c43160e431572f0edea13f8a475");
  assert.equal(zero.chainHash, "dbd3d04fbfab653d6ababe088c14d4fa6ca502188788e7605a46a4aba43d62f5");
});

test("tamper: flip a record byte → contentDigest differs", () => {
  const x = clone(fixedMulti());
  x.records[1].bytesB64 = Buffer.from(rec(3, "e2-DIFFERENT", "effect_result")).toString("base64");
  assert.notEqual(recomputeFromExport(x).contentDigest, x.contentDigest);
});

test("tamper: reorder records → contentDigest differs (chain is order-sensitive)", () => {
  const x = clone(fixedMulti());
  [x.records[0], x.records[1]] = [x.records[1], x.records[0]];
  assert.notEqual(recomputeFromExport(x).contentDigest, x.contentDigest);
});

test("tamper: drop a record (recordCount desync) → contentDigest differs", () => {
  const x = clone(fixedMulti());
  x.records.pop();
  assert.notEqual(recomputeFromExport(x).contentDigest, x.contentDigest);
});

test("tamper: tamper the snapshot bytes → contentDigest differs", () => {
  const x = clone(fixedMulti());
  x.snapshot!.bytesB64 = Buffer.from(encode({ phase: "await_model", n: 999 })).toString("base64");
  assert.notEqual(recomputeFromExport(x).contentDigest, x.contentDigest);
});

test("stored per-record hash is diagnostic: editing it does NOT change the recomputed digest, but the diagnostic mismatch is visible", () => {
  const x = clone(fixedMulti());
  const before = recomputeFromExport(x).contentDigest;
  x.records[0].hash = "deadbeef".repeat(8); // forge the stored hash
  const after = recomputeFromExport(x);
  assert.equal(after.contentDigest, before); // authoritative recompute ignores stored hashes
  assert.notEqual(after.recordHashes[0], x.records[0].hash); // diagnostic mismatch detectable
});

test("encodeExport ∘ decodeExport is value-identical", () => {
  const x = fixedMulti();
  assert.deepEqual(decode(encodeExport(x)), decode(encodeExport(clone(x))));
  assert.equal(decodeExport(encodeExport(x)).contentDigest, x.contentDigest);
});
