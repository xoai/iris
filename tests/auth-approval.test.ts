// T2 — decideApproval(): combine the human's raw decision (approve/deny) with the
// policy. The tool runs (approved:true) ONLY when the human approved AND the policy
// permits this principal. Unauthorized "approve" → approved:false (tool skipped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval } from "@irisrun/auth";
import type { ApprovalPolicy, Principal, GovernedAction } from "@irisrun/auth";

const rm: GovernedAction = { name: "rm", callId: "c1" };
const alice: Principal = { id: "alice", roles: ["admin"] };
const bob: Principal = { id: "bob", roles: ["dev"] };
const adminOnly: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }] };

test("authorized approve → approved:true, authorized:true", () => {
  const d = decideApproval({ policy: adminOnly, principal: alice, intent: "approve", action: rm });
  assert.equal(d.approved, true);
  assert.equal(d.authorized, true);
  assert.equal(d.intent, "approve");
  assert.match(d.reason, /approved by 'alice'/);
});

test("unauthorized approve → approved:false, authorized:false (tool will be skipped)", () => {
  const d = decideApproval({ policy: adminOnly, principal: bob, intent: "approve", action: rm });
  assert.equal(d.approved, false);
  assert.equal(d.authorized, false);
  assert.match(d.reason, /unauthorized/i);
});

test("deny by an authorized principal → approved:false, authorized:true", () => {
  const d = decideApproval({ policy: adminOnly, principal: alice, intent: "deny", action: rm });
  assert.equal(d.approved, false);
  assert.equal(d.authorized, true);
  assert.equal(d.intent, "deny");
  assert.match(d.reason, /denied by 'alice'/);
});

test("deny by an unauthorized principal → approved:false, authorized:false", () => {
  const d = decideApproval({ policy: adminOnly, principal: bob, intent: "deny", action: rm });
  assert.equal(d.approved, false);
  assert.equal(d.authorized, false);
});

test("the principal and action are echoed verbatim into the governed value", () => {
  const d = decideApproval({ policy: adminOnly, principal: alice, intent: "approve", action: rm });
  assert.deepEqual(d.principal, alice);
  assert.deepEqual(d.action, rm);
});
