// @irisrun/auth — the governance layer (roadmap P1-5). Identity + a declarative
// who-may-approve authorization policy on the existing HITL approval gate, plus a
// journaled, queryable approval audit trail. Pure: the governed decision rides the
// existing journaled `signal_recv` effect result (the kernel's `foldApproval` reads
// only `approved===true`), so governance enriches that value with ZERO kernel change.
export const PACKAGE = "@irisrun/auth";

// identity.ts — the domain nouns (who + what)
export type { Principal, GovernedAction } from "./identity.ts";
// policy.ts — who-may-approve authorization (done-when #1)
export { authorize } from "./policy.ts";
export type { ApprovalPolicy, ApprovalRule, AuthDecision } from "./policy.ts";
// approval.ts — combine human intent + policy into the journaled value
export { decideApproval } from "./approval.ts";
export type { RawApproval, GovernedApproval } from "./approval.ts";
// performer.ts — the first real governed signal_recv performer + the approval inbox
export { createApprovalInbox, makeGovernedApprovalPerformer } from "./performer.ts";
export type { ApprovalInbox } from "./performer.ts";
// audit.ts — the journaled, queryable approval trail (done-when #2)
export { approvalAudit, auditApprovals, renderApprovalAudit } from "./audit.ts";
export type { ApprovalAuditEntry } from "./audit.ts";
