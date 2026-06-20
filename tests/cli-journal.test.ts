// T5: the `iris journal export|verify|import` command logic over injected
// stores / raw bytes (cli-main.ts's journalCommand real-IO dispatch is not
// unit-tested, per repo convention — cf. cli-audit.test.ts). Exit code is a
// RETURN VALUE; the dispatcher (not under test) calls process.exit with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStateStore } from "@irisrun/store-memory";
import { cmdJournalExport, cmdJournalVerify, cmdJournalImport } from "iris-runtime";
import { recordGovernedSession } from "./lib/record-governed-session.ts";

test("export → verify (exit 0) → import → resume-equivalent", async () => {
  const src = await recordGovernedSession();
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  assert.equal(ex.exitCode, 0);
  assert.match(ex.text, /contentDigest [0-9a-f]{64}/);

  const v = cmdJournalVerify({ bytes: ex.bytes });
  assert.equal(v.ok, true, JSON.stringify(v.result.issues));
  assert.equal(v.exitCode, 0);
  assert.match(v.text, /journal verify: OK/);

  const dst = new MemoryStateStore();
  const im = await cmdJournalImport({ store: dst, bytes: ex.bytes });
  assert.equal(im.exitCode, 0);
  assert.equal(im.sessionId, "s");
  // the imported session is verifiable on the destination
  const v2 = cmdJournalVerify({ bytes: (await cmdJournalExport({ store: dst, sessionId: "s" })).bytes });
  assert.equal(v2.ok, true);
});

test("tampered file → verify exit 1, no throw", async () => {
  const src = await recordGovernedSession();
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  const tampered = new Uint8Array(ex.bytes);
  // flip a byte somewhere in the middle of the file
  tampered[Math.floor(tampered.length / 2)] ^= 0x7f;
  const v = cmdJournalVerify({ bytes: tampered });
  assert.equal(v.ok, false);
  assert.equal(v.exitCode, 1);
  assert.match(v.text, /FAILED/);
});

test("verify --replay (Tier 2) rebuilds the harness reducer and confirms determinism", async () => {
  const src = await recordGovernedSession();
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  const v = cmdJournalVerify({ bytes: ex.bytes, replay: true });
  assert.equal(v.ok, true, JSON.stringify(v.result.issues));
  assert.ok(v.result.replay);
  assert.equal(v.result.replay!.ok, true);
  assert.match(v.text, /replay\s+OK/);
});

test("verify --replay on a snapshot/truncated session uses the snapshot as start state", async () => {
  const src = await recordGovernedSession({ snapshotThreshold: 2 });
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  assert.equal(ex.export.complete, false);
  const v = cmdJournalVerify({ bytes: ex.bytes, replay: true });
  assert.equal(v.ok, true, JSON.stringify(v.result.issues));
  assert.equal(v.result.replay!.ok, true);
});

test("verify with a wrong --image pin (expectDefDigest) → exit 1", async () => {
  const src = await recordGovernedSession();
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  const v = cmdJournalVerify({ bytes: ex.bytes, expectDefDigest: "sha256:WRONG" });
  assert.equal(v.ok, false);
  assert.equal(v.exitCode, 1);
  assert.ok(v.result.issues.some((i) => /pin mismatch/.test(i)));
});

test("import refuses a non-empty destination (exit-equivalent throw surfaced by the dispatcher)", async () => {
  const src = await recordGovernedSession();
  const ex = await cmdJournalExport({ store: src, sessionId: "s" });
  const dst = new MemoryStateStore();
  await cmdJournalImport({ store: dst, bytes: ex.bytes });
  await assert.rejects(() => cmdJournalImport({ store: dst, bytes: ex.bytes }), /already has session/);
});
