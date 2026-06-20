// T3 — the governed signal_recv performer + the approval inbox. HARD CONTRACT: the
// performer is folded in the kernel's `recv_hitl` phase, which has NO failure handler
// — a {ok:false} there is journaled and re-throws forever on replay (poisons the
// session). So the performer ALWAYS returns {ok:true}. It must also be idempotent
// across a recovery re-perform (same callId → same decision, never flips).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovalInbox, makeGovernedApprovalPerformer } from "@irisrun/auth";
import type { ApprovalPolicy, GovernedAction, GovernedApproval } from "@irisrun/auth";

const rm: GovernedAction = { name: "rm", callId: "c1" };
const adminOnly: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }] };

function value(out: Awaited<ReturnType<ReturnType<typeof makeGovernedApprovalPerformer>>>): GovernedApproval {
  assert.equal(out.ok, true, "performer must always return ok:true");
  return (out as { ok: true; value: GovernedApproval }).value;
}

test("authorized approve → {ok:true} with approved:true", async () => {
  const inbox = createApprovalInbox();
  inbox.submit(rm, { principal: { id: "alice", roles: ["admin"] }, intent: "approve" });
  const perf = makeGovernedApprovalPerformer({ policy: adminOnly, inbox });
  const out = await perf({ name: "hitl:c1" });
  assert.equal(value(out).approved, true);
});

test("unauthorized approve → {ok:true} with approved:false (NEVER {ok:false})", async () => {
  const inbox = createApprovalInbox();
  inbox.submit(rm, { principal: { id: "bob", roles: ["dev"] }, intent: "approve" });
  const perf = makeGovernedApprovalPerformer({ policy: adminOnly, inbox });
  const out = await perf({ name: "hitl:c1" });
  assert.equal(out.ok, true);
  assert.equal(value(out).approved, false);
  assert.equal(value(out).authorized, false);
});

test("parses the callId out of the hitl:<callId> signal name", async () => {
  const inbox = createApprovalInbox();
  inbox.submit({ name: "deploy", callId: "x-42" }, { principal: { id: "a", roles: ["admin"] }, intent: "approve" });
  const policy: ApprovalPolicy = { rules: [{ tool: "deploy", anyOfRoles: ["admin"] }] };
  const perf = makeGovernedApprovalPerformer({ policy, inbox });
  const out = await perf({ name: "hitl:x-42" });
  assert.equal(value(out).action.callId, "x-42");
  assert.equal(value(out).approved, true);
});

test("no recorded decision → fail-safe {ok:true, approved:false} (session stays unbroken)", async () => {
  const inbox = createApprovalInbox();
  const perf = makeGovernedApprovalPerformer({ policy: adminOnly, inbox });
  const out = await perf({ name: "hitl:missing" });
  assert.equal(out.ok, true);
  assert.equal(value(out).approved, false);
  assert.match(value(out).reason, /no approval decision recorded/i);
});

test("inbox.get is idempotent: a recovery re-perform yields an identical decision (no flip)", async () => {
  const inbox = createApprovalInbox();
  inbox.submit(rm, { principal: { id: "alice", roles: ["admin"] }, intent: "approve" });
  const perf = makeGovernedApprovalPerformer({ policy: adminOnly, inbox });
  const first = value(await perf({ name: "hitl:c1" }));
  const second = value(await perf({ name: "hitl:c1" }));
  assert.deepEqual(first, second);
});

test("a non-hitl signal name fails safe, not loud", async () => {
  const inbox = createApprovalInbox();
  const perf = makeGovernedApprovalPerformer({ policy: adminOnly, inbox });
  const out = await perf({ name: "timer:wake" });
  assert.equal(out.ok, true);
  assert.equal(value(out).approved, false);
});

test("a misconfigured policy that throws is caught → {ok:true, approved:false} (contract is absolute)", async () => {
  const inbox = createApprovalInbox();
  inbox.submit(rm, { principal: { id: "alice", roles: ["admin"] }, intent: "approve" });
  // An operator misconfiguration: `rules` is not iterable → authorize() throws. The
  // performer MUST still return {ok:true} (recv_hitl has no failure handler).
  const broken = { rules: undefined } as unknown as ApprovalPolicy;
  const perf = makeGovernedApprovalPerformer({ policy: broken, inbox });
  const out = await perf({ name: "hitl:c1" });
  assert.equal(out.ok, true, "must never return ok:false even on a thrown error");
  assert.equal(value(out).approved, false);
  assert.match(value(out).reason, /governance error/i);
});
