// T4: verifyExport — two-tier, never-throws. Tier 1 is file-only (no store, no
// image): content-address + structure + canonical-bytes. Tier 2 replays given a
// caller-supplied reducer. Every malformed input is ok:false with a named issue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "@irisrun/core";
import { exportSession, encodeExport, decodeExport, verifyExport, buildExport } from "@irisrun/journal-export";
import type { JournalExportV1 } from "@irisrun/journal-export";
import { recordGovernedSession, harnessReducer, harnessInitial } from "./lib/record-governed-session.ts";

async function cleanExportBytes(): Promise<Uint8Array> {
  const src = await recordGovernedSession();
  return encodeExport(await exportSession(src, "s"));
}
const reB64 = (s: string) => Buffer.from(s).toString("base64");

test("Tier 1: a clean export verifies file-only (no store, no image)", async () => {
  const r = verifyExport(await cleanExportBytes());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.contentAddress.ok, true);
  assert.equal(r.structural.ok, true);
  assert.equal(r.replay, undefined); // no reducer → no Tier 2
});

test("tamper: flipping a record byte fails with a content-address issue (no throw)", async () => {
  const x = decodeExport(await cleanExportBytes());
  x.records[0].bytesB64 = reB64(JSON.stringify({ seq: x.records[0].seq, tampered: true }));
  const r = verifyExport(encodeExport(x));
  assert.equal(r.ok, false);
  assert.equal(r.contentAddress.ok, false);
  assert.ok(r.issues.some((i) => /digest mismatch|does not match its bytes/.test(i)));
});

test("garbage bytes → ok:false, no throw", () => {
  const r = verifyExport(new TextEncoder().encode("this is not json"));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not a valid iris-journal-export/.test(i)));
});

test("valid JSON that is not an export → ok:false, no throw", () => {
  const r = verifyExport(encode({ hello: "world" }));
  assert.equal(r.ok, false);
});

test("valid envelope + non-JSON record payload → ok:false, no throw", async () => {
  const x = decodeExport(await cleanExportBytes());
  x.records[1].bytesB64 = reB64("{"); // base64 of an un-parseable fragment
  const r = verifyExport(encodeExport(x));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not canonical JSON|does not match its bytes/.test(i)));
});

test("valid envelope + Infinity payload (JSON.parse does NOT throw) → caught by canonical-bytes check", async () => {
  const x = decodeExport(await cleanExportBytes());
  x.records[1].bytesB64 = reB64("1e400"); // JSON.parse → Infinity; encode/canonicalize throws
  const r = verifyExport(encodeExport(x));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not canonical JSON|does not match its bytes/.test(i)));
});

test("non-canonical-but-valid record (unsorted keys) → canonical-bytes mismatch flagged", async () => {
  const x = decodeExport(await cleanExportBytes());
  x.records[1].bytesB64 = reB64('{"b":1,"a":2}'); // valid JSON, NOT canonical (keys unsorted)
  const r = verifyExport(encodeExport(x));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not canonical|does not match its bytes/.test(i)));
});

test("Tier 2: replay verifies with the caller-supplied harness reducer", async () => {
  const bytes = await cleanExportBytes(); // no-snapshot session → supply harnessInitial as start
  const r = verifyExport(bytes, { reducer: harnessReducer(), startState: harnessInitial() });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.replay);
  assert.equal(r.replay!.ok, true);
  assert.equal(typeof r.finalStateDigest, "string");
});

test("PIN: a wrong expectDefDigest is flagged (file has a governing digest)", async () => {
  const x = decodeExport(await cleanExportBytes());
  assert.notEqual(x.defDigest, ""); // governed session has a defDigest
  const r = verifyExport(encodeExport(x), { expectDefDigest: "sha256:WRONG" });
  assert.equal(r.ok, false);
  assert.ok(r.structural.issues.some((i) => /defDigest pin mismatch/.test(i)));
});

test("PIN: skipped (not failed) when the file has no governing digest (0-record export)", () => {
  const x: JournalExportV1 = buildExport({
    sessionId: "s",
    defDigest: "",
    complete: false,
    snapshot: { upToSeq: 5, bytes: encode({ phase: "await_model" }) },
    records: [],
  });
  assert.equal(x.defDigest, "");
  const r = verifyExport(encodeExport(x), { expectDefDigest: "sha256:ANY" });
  assert.equal(r.defDigest, "");
  assert.ok(!r.issues.some((i) => /pin mismatch/.test(i)));
  assert.equal(r.contentAddress.ok, true); // otherwise structurally sound
});

test("third-party: verify a file produced by a different process, with only the bytes", async () => {
  const bytes = await cleanExportBytes(); // produced elsewhere; verifier has no store/image
  const r = verifyExport(bytes);
  assert.equal(r.ok, true);
});
