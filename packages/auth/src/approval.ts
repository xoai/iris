// The governed approval decision (roadmap P1-5). Combines the human's raw decision
// with the authorization policy into the value that rides the journaled `signal_recv`
// effect result. The kernel's `foldApproval` (@irisrun/core kernel.ts:197) reads ONLY
// `approved===true`; the other fields are audit metadata that persist in the journal.
// Pure — no kernel change, no clock/RNG.
import type { Principal, GovernedAction } from "./identity.ts";
import type { ApprovalPolicy } from "./policy.ts";
import { authorize } from "./policy.ts";

// The raw human decision delivered for a gated call (before policy is applied).
export type RawApproval = { principal: Principal; intent: "approve" | "deny" };

// The journaled approval value. `approved` is what the kernel reads to run/skip the
// tool; the rest is the queryable audit context.
export type GovernedApproval = {
  approved: boolean; // intent === "approve" && authorized — the kernel reads this
  intent: "approve" | "deny"; // the human's raw decision
  authorized: boolean; // did the policy permit this principal for this action
  principal: Principal;
  action: GovernedAction;
  reason: string; // human-readable explanation (audit)
};

/** Combine a human decision with the policy. Pure. Tool runs only on
 *  approve + authorized; an unauthorized "approve" yields approved:false. */
export function decideApproval(input: {
  policy: ApprovalPolicy;
  principal: Principal;
  intent: "approve" | "deny";
  action: GovernedAction;
}): GovernedApproval {
  const { policy, principal, intent, action } = input;
  const auth = authorize(policy, principal, action);
  const authorized = auth.permit;
  const approved = intent === "approve" && authorized;

  let reason: string;
  if (intent === "deny") {
    reason = `denied by '${principal.id}'`;
  } else if (authorized) {
    reason = `approved by '${principal.id}' (${auth.reason})`;
  } else {
    reason = `unauthorized: ${auth.reason}`;
  }

  return { approved, intent, authorized, principal, action, reason };
}
