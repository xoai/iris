// T4 — approvalAudit(): project an ordered approval trail from a recorded session.
// It joins hitl signal_recv intents to their results by effectId and reads each
// result's value — governed (full identity) OR legacy bare {approved}. Non-HITL
// signals and non-effect records are excluded, never crash the join.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalAudit, renderApprovalAudit } from "@iris/auth";
import type { GovernedApproval } from "@iris/auth";
import type { SessionInspection, InspectedRecord } from "@iris/inspect";
import type { Json } from "@iris/core";

function rec(seq: number, kind: InspectedRecord["kind"], detail: Json): InspectedRecord {
  return { seq, ts: seq, defDigest: "d", kind, summary: "", detail };
}

const governed: GovernedApproval = {
  approved: true,
  intent: "approve",
  authorized: true,
  principal: { id: "alice", roles: ["admin"] },
  action: { name: "rm", callId: "c1" },
  reason: "approved by 'alice'",
};

function inspection(records: InspectedRecord[]): SessionInspection {
  return {
    sessionId: "s",
    governingDigest: "d",
    snapshotUpTo: null,
    records,
    counts: { effects: 0, results: 0, markers: 0, decisions: 0 },
    terminal: "finished",
  };
}

const RECORDS: InspectedRecord[] = [
  rec(1, "effect_intent", { effectId: "model_call:1", effectKind: "model_call", request: {}, retrySafe: false }),
  rec(2, "effect_result", { effectId: "model_call:1", outcome: { ok: true, value: {} } }),
  // governed approval (c1)
  rec(3, "effect_intent", { effectId: "signal_recv:3", effectKind: "signal_recv", request: { name: "hitl:c1" }, retrySafe: false }),
  rec(4, "effect_result", { effectId: "signal_recv:3", outcome: { ok: true, value: governed as unknown as Json } }),
  // legacy bare {approved} (c2)
  rec(5, "effect_intent", { effectId: "signal_recv:5", effectKind: "signal_recv", request: { name: "hitl:c2" }, retrySafe: false }),
  rec(6, "effect_result", { effectId: "signal_recv:5", outcome: { ok: true, value: { approved: false } } }),
  // a NON-hitl signal_recv — must be excluded
  rec(7, "effect_intent", { effectId: "signal_recv:7", effectKind: "signal_recv", request: { name: "timer:wake" }, retrySafe: false }),
  rec(8, "effect_result", { effectId: "signal_recv:7", outcome: { ok: true, value: {} } }),
  // a marker — must not crash the join
  rec(9, "marker", { marker: "finish" }),
];

test("projects governed and legacy approvals, ordered by seq; excludes non-hitl", () => {
  const entries = approvalAudit(inspection(RECORDS));
  assert.equal(entries.length, 2, "only the two hitl approvals (not the timer signal)");
  assert.deepEqual(entries.map((e) => e.callId), ["c1", "c2"]);
});

test("governed entry carries full identity + authorization", () => {
  const [c1] = approvalAudit(inspection(RECORDS));
  assert.equal(c1.callId, "c1");
  assert.equal(c1.tool, "rm");
  assert.deepEqual(c1.principal, { id: "alice", roles: ["admin"] });
  assert.equal(c1.intent, "approve");
  assert.equal(c1.approved, true);
  assert.equal(c1.authorized, true);
  assert.match(c1.reason ?? "", /approved by 'alice'/);
});

test("legacy bare {approved} entry is listed with null identity", () => {
  const c2 = approvalAudit(inspection(RECORDS))[1];
  assert.equal(c2.callId, "c2");
  assert.equal(c2.approved, false);
  assert.equal(c2.principal, null);
  assert.equal(c2.tool, null);
  assert.equal(c2.authorized, null);
});

test("renderApprovalAudit is deterministic and one line per entry", () => {
  const text = renderApprovalAudit(approvalAudit(inspection(RECORDS)));
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /c1/);
  assert.match(text, /alice/);
});

test("empty / no-approval session renders a clear placeholder", () => {
  assert.equal(approvalAudit(inspection([])).length, 0);
  assert.match(renderApprovalAudit([]), /no approvals/i);
});
