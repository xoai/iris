// T1 — authorize(): the declarative who-may-approve policy. A rule GRANTS iff its
// tool matches the action AND the principal satisfies it (role ∩ anyOfRoles, or id ∈
// principals). Any granting rule → permit; else policy.default ("deny" by default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "@irisrun/auth";
import type { ApprovalPolicy, Principal, GovernedAction } from "@irisrun/auth";

const rm: GovernedAction = { name: "rm", callId: "c1" };
const alice: Principal = { id: "alice", roles: ["dev", "admin"] };
const bob: Principal = { id: "bob", roles: ["dev"] };

test("grants by role when a tool rule names a role the principal holds", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }] };
  const d = authorize(policy, alice, rm);
  assert.equal(d.permit, true);
  assert.match(d.reason, /grant/i);
});

test("denies (default) when the principal lacks the required role", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }] };
  const d = authorize(policy, bob, rm);
  assert.equal(d.permit, false);
  assert.match(d.reason, /no rule grants/i);
});

test("grants by principal id (no role needed)", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", principals: ["bob"] }] };
  assert.equal(authorize(policy, bob, rm).permit, true);
});

test("a '*' tool rule matches any tool name", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "*", anyOfRoles: ["dev"] }] };
  assert.equal(authorize(policy, bob, { name: "anything", callId: "c9" }).permit, true);
});

test("an undefined tool rule applies to every tool", () => {
  const policy: ApprovalPolicy = { rules: [{ anyOfRoles: ["dev"] }] };
  assert.equal(authorize(policy, bob, rm).permit, true);
});

test("a tool-specific rule does not match a different tool (falls to default)", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["dev"] }] };
  const d = authorize(policy, bob, { name: "ls", callId: "c2" });
  assert.equal(d.permit, false);
});

test("default 'permit' grants when no rule matches", () => {
  const policy: ApprovalPolicy = { rules: [], default: "permit" };
  const d = authorize(policy, bob, rm);
  assert.equal(d.permit, true);
  assert.match(d.reason, /default permit/i);
});

test("absent default is 'deny' (secure default)", () => {
  const policy: ApprovalPolicy = { rules: [] };
  assert.equal(authorize(policy, bob, rm).permit, false);
});

test("a principal with no roles is not granted by a role rule", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["dev"] }] };
  assert.equal(authorize(policy, { id: "carol" }, rm).permit, false);
});

test("a rule with neither roles nor principals never grants (must name grantees)", () => {
  const policy: ApprovalPolicy = { rules: [{ tool: "rm" }] };
  assert.equal(authorize(policy, alice, rm).permit, false);
});

test("first granting rule wins across multiple rules", () => {
  const policy: ApprovalPolicy = {
    rules: [
      { tool: "ls", anyOfRoles: ["dev"] }, // doesn't match rm
      { tool: "rm", anyOfRoles: ["admin"] }, // grants alice
    ],
  };
  assert.equal(authorize(policy, alice, rm).permit, true);
});
