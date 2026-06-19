// The first REAL signal_recv performer (until now only a test fixture existed). It
// delivers a GOVERNED approval: parse the parked `hitl:<callId>` signal, look up the
// recorded human decision, apply the policy, and return the GovernedApproval as the
// journaled value.
//
// HARD RULE (memory: journal-poison gotcha): this performer is folded in the kernel's
// `recv_hitl` phase, which has NO failure handler (@iris/core kernel.ts:262-275). A
// {ok:false} there is journaled and re-throws forever on replay. So this ALWAYS
// returns {ok:true} — an unauthorized/denied/absent decision is a well-formed
// {ok:true, value:{approved:false,…}}, never an error.
import type { Json, Performer, Outcome } from "@iris/core";
import type { GovernedAction } from "./identity.ts";
import type { RawApproval } from "./approval.ts";
import { decideApproval } from "./approval.ts";
import type { ApprovalPolicy } from "./policy.ts";

const HITL_PREFIX = "hitl:";

// A recorded-decision store keyed by callId. `submit` ties the gated action (callId +
// tool) to the human's raw decision; `get` is NON-CONSUMING so a recovery re-perform
// of the dangling signal_recv intent reads the SAME record and never flips the
// approval. A channel/UI submits here, then signals `hitl:<callId>` to resume.
export interface ApprovalInbox {
  submit(action: GovernedAction, decision: RawApproval): void;
  get(callId: string): { action: GovernedAction; decision: RawApproval } | undefined;
}

export function createApprovalInbox(): ApprovalInbox {
  const decisions = new Map<string, { action: GovernedAction; decision: RawApproval }>();
  return {
    submit(action, decision) {
      decisions.set(action.callId, { action, decision });
    },
    get(callId) {
      return decisions.get(callId);
    },
  };
}

/** Build the governed `signal_recv` performer for a policy + inbox. */
export function makeGovernedApprovalPerformer(opts: {
  policy: ApprovalPolicy;
  inbox: ApprovalInbox;
}): Performer {
  const { policy, inbox } = opts;
  return async (request: Json): Promise<Outcome> => {
    // Outer guard: this performer is folded in `recv_hitl`, a phase with NO failure
    // handler — ANY throw or {ok:false} is journaled and re-throws forever on replay
    // (poisons the session). So even an OPERATOR misconfiguration (e.g. a malformed
    // `policy`) must fail safe, not loud. Per-request input is guarded below; this
    // catch is the last-resort backstop that keeps the {ok:true} contract absolute.
    try {
      // Guard the boundary: the kernel hands `{ name: "hitl:<callId>" }`. Anything else
      // (a malformed request, a non-HITL signal) fails SAFE, never loud.
      const name =
        request !== null && typeof request === "object" && !Array.isArray(request)
          ? (request as { name?: Json }).name
          : undefined;
      if (typeof name !== "string" || !name.startsWith(HITL_PREFIX)) {
        return { ok: true, value: { approved: false, reason: `governed approval: not a hitl signal (${JSON.stringify(name ?? null)})` } };
      }

      const callId = name.slice(HITL_PREFIX.length);
      const recorded = inbox.get(callId);
      if (!recorded) {
        // The decision must be submitted before the resume signal; absent is a wiring
        // gap, not an error — skip the tool with a clear reason rather than poison.
        return { ok: true, value: { approved: false, reason: `no approval decision recorded for '${callId}'` } };
      }

      const governed = decideApproval({
        policy,
        principal: recorded.decision.principal,
        intent: recorded.decision.intent,
        action: recorded.action,
      });
      return { ok: true, value: governed };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: true, value: { approved: false, reason: `governance error (denied for safety): ${message}` } };
    }
  };
}
