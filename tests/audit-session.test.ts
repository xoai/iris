// P2-8 M1 — auditSession()/renderAudit(): whole-session, compliance-grade audit
// over the FULL retained journal (seq 0), with completeness detection. The headline
// regression is the snapshot+truncate boundary (LRN:gotcha d8ddf8a1): a complete
// trail requires keepHistory; a truncated session must report complete:false LOUDLY
// rather than silently dropping pre-snapshot events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "@iris/core";
import type { Json } from "@iris/core";
import { MemoryStateStore } from "@iris/store-memory";
import { auditSession, renderAudit } from "@iris/audit";
import { recordGovernedSession } from "./lib/record-governed-session.ts";

test("audit (a) never-started session: complete:true (vacuous), empty trail, terminal open", async () => {
  const store = new MemoryStateStore();
  const a = await auditSession(store, "s");
  assert.equal(a.sessionId, "s");
  assert.equal(a.complete, true, "a never-started session is trivially complete");
  assert.equal(a.firstRetainedSeq, 0);
  assert.equal(a.truncatedBefore, null);
  assert.equal(a.snapshotUpTo, null);
  assert.equal(a.governingDigest, null);
  assert.equal(a.terminal, "open");
  assert.deepEqual(a.records, []);
  assert.deepEqual(a.approvals, []);
  assert.deepEqual(a.counts, { effects: 0, results: 0, markers: 0, decisions: 0 });
});

test("audit (b) short non-snapshotting session: full trail, typed entries, complete, governing digest", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 64 });
  const a = await auditSession(store, "s");
  assert.equal(a.complete, true);
  assert.equal(a.firstRetainedSeq, 0, "full history retained from seq 0");
  assert.equal(a.truncatedBefore, null);
  assert.equal(a.governingDigest, "d");
  assert.equal(a.terminal, "finished");
  assert.ok(a.records.length >= 6, `expected a rich trail, got ${a.records.length}`);
  a.records.forEach((r, i) => assert.equal(r.seq, i, "dense seq from 0"));
  const intent = a.records.find((r) => r.kind === "effect_intent");
  assert.ok(intent && typeof intent.effectKind === "string" && typeof intent.effectId === "string", "intent carries effectKind+effectId");
  const result = a.records.find((r) => r.kind === "effect_result");
  assert.ok(result && (result.outcome === "ok" || result.outcome === "error"), "result carries outcome");
  assert.equal(a.counts.effects, a.counts.results, "finished session: every intent has a result");
  assert.ok(a.counts.markers > 0);
  const again = await auditSession(store, "s");
  assert.equal(canonicalize(a as unknown as Json), canonicalize(again as unknown as Json), "re-audit is byte-identical");
});

test("audit (c) snapshot+truncate boundary, default keepHistory: complete:false + truncatedBefore (THE gotcha)", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 2 }); // default: truncates
  const a = await auditSession(store, "s");
  assert.notEqual(a.snapshotUpTo, null, "a snapshot+truncate boundary was crossed");
  assert.equal(a.complete, false, "truncated prefix → NOT complete (must be loud, not silent)");
  assert.ok(a.firstRetainedSeq > 0, "retained journal no longer starts at seq 0");
  assert.equal(a.truncatedBefore, a.firstRetainedSeq);
  assert.equal(a.approvals.length, 0, "truncated approval is absent without keepHistory");
});

test("audit (d) snapshot boundary, keepHistory:true: complete:true + pre-snapshot approval present", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 2, keepHistory: true });
  const a = await auditSession(store, "s");
  assert.notEqual(a.snapshotUpTo, null, "a snapshot boundary was crossed (exercising the limitation)");
  assert.equal(a.complete, true, "retained history → complete across the snapshot");
  assert.equal(a.firstRetainedSeq, 0);
  assert.equal(a.truncatedBefore, null);
  assert.equal(a.approvals.length, 1, "the approval is queryable across the snapshot");
  assert.equal(a.approvals[0].callId, "a");
  assert.equal(a.approvals[0].approved, true);
  assert.deepEqual(a.approvals[0].principal, { id: "alice", roles: ["dev"] });
});

test("audit (f) renderAudit: COMPLETE header + approvals; PARTIAL header + keepHistory hint when truncated", async () => {
  const complete = await auditSession(await recordGovernedSession({ snapshotThreshold: 2, keepHistory: true }), "s");
  const textC = renderAudit(complete);
  assert.match(textC, /session s/);
  assert.match(textC, /COMPLETE/);
  assert.match(textC, /alice/, "approvals block names the approver");
  assert.equal(renderAudit(complete), textC, "deterministic render");

  const partial = await auditSession(await recordGovernedSession({ snapshotThreshold: 2 }), "s");
  const textP = renderAudit(partial);
  assert.match(textP, /PARTIAL/);
  assert.match(textP, /keepHistory/i, "PARTIAL render hints how to get a complete trail");
});
