// The who-may-approve authorization policy. Declarative
// and Json-shaped so it is serializable, inspectable, and (future) pinnable. Pure:
// no clock/RNG, no `ts` reads — the decision is journaled and folded once, so replay
// reproduces it without re-evaluating the policy.
import type { Principal, GovernedAction } from "./identity.ts";

// A single grant rule. A rule GRANTS an approval iff BOTH hold:
//   • its `tool` matches the action — undefined or "*" = any tool, else exact name; and
//   • the principal satisfies it — holds one of `anyOfRoles`, OR its id is in `principals`.
// A rule that names neither `anyOfRoles` nor `principals` names no grantees and never
// grants (for "anyone may approve", use `default: "permit"`). This keeps the secure
// thing easy and the permissive thing explicit.
export type ApprovalRule = {
  tool?: string;
  anyOfRoles?: string[];
  principals?: string[];
};

export type ApprovalPolicy = {
  rules: ApprovalRule[];
  // Applied when NO rule grants. Absent ⇒ "deny" (the secure default).
  default?: "deny" | "permit";
};

export type AuthDecision = { permit: boolean; reason: string };

function toolMatches(rule: ApprovalRule, action: GovernedAction): boolean {
  return rule.tool === undefined || rule.tool === "*" || rule.tool === action.name;
}

/** Does `principal` may-approve `action` under `policy`? Pure. */
export function authorize(
  policy: ApprovalPolicy,
  principal: Principal,
  action: GovernedAction,
): AuthDecision {
  const roles = principal.roles ?? [];
  for (const rule of policy.rules) {
    if (!toolMatches(rule, action)) continue;
    const byRole = (rule.anyOfRoles ?? []).some((r) => roles.includes(r));
    const byId = (rule.principals ?? []).includes(principal.id);
    if (byRole || byId) {
      return {
        permit: true,
        reason: `granted: '${principal.id}' satisfies a rule for '${action.name}' (by ${byRole ? "role" : "principal id"})`,
      };
    }
  }
  const fallback = policy.default ?? "deny";
  return fallback === "permit"
    ? { permit: true, reason: `default permit: no rule matched '${action.name}'` }
    : { permit: false, reason: `denied: no rule grants '${principal.id}' approval of '${action.name}'` };
}
