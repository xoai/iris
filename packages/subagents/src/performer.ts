// makeSubagentPerformer (P2-9, spec §4.3): the host-side performer for the `subagent`
// EffectKind. The kernel's tool_exec step emits a `subagent` effect whose request is the
// delegating ToolCall {callId, name, args}; this performer derives the deterministic child
// sessionId, resolves the child agent, drives it to completion, and maps the outcome back
// to the parent's effect result.
//
// JOURNAL-POISON SAFETY (see the iris failed-model-call lesson): the `subagent` effect
// rides the kernel's `tool_exec` phase, which HAS a failure handler (`tool_error`). So an
// EXPECTED outcome (finished/parked/exhausted) is absorbed to {ok:true} — the parent model
// reads it as a normal observation — and only genuine infra contention (`aborted`) is
// {ok:false}, which the tool_error seam can retry. Never a {ok:false} the kernel can't handle.
import type { Performer, Outcome, Json, HarnessState } from "@irisrun/core";
import { childSessionId } from "./id.ts";
import { driveToCompletion, type DriveToCompletionDeps } from "./drive.ts";

// What `resolveChild` returns: everything driveToCompletion needs to run the child agent
// (its host, image digest, program, performers, clock, optional caps). Returning null
// REFUSES the delegation (an unknown child agent) → a clean {ok:false, unknown_subagent}.
export type ResolvedChild = DriveToCompletionDeps<HarnessState>;

export interface SubagentPerformerDeps {
  // Build the child run for a delegation. `childSessionId` is the deterministic id the
  // performer derived (pass it through to the child host). `args` is the delegating call's
  // args (the task payload). null → unknown child agent.
  resolveChild: (call: { name: string; args: Json; childSessionId: string }) => ResolvedChild | null;
  // The parent session, for deterministic child-id derivation (idempotent recovery).
  parentSessionId: string;
  onWarn?: (message: string) => void;
}

export function makeSubagentPerformer(deps: SubagentPerformerDeps): Performer {
  return async (request: Json): Promise<Outcome> => {
    // Validate the delegating call shape — a malformed request is a programming error, not
    // a child outcome; fail loudly (no silent success).
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      return badRequest("request must be a tool-call object");
    }
    const call = request as { callId?: Json; name?: Json; args?: Json };
    if (typeof call.callId !== "string" || call.callId === "") {
      return badRequest("request needs a non-empty string callId");
    }
    if (typeof call.name !== "string" || call.name === "") {
      return badRequest("request needs a non-empty string name");
    }

    const child = childSessionId(deps.parentSessionId, call.callId);
    const resolved = deps.resolveChild({ name: call.name, args: call.args ?? null, childSessionId: child });
    if (resolved === null) {
      if (deps.onWarn) deps.onWarn(`subagent: no child agent registered for "${call.name}"`);
      return { ok: false, error: { message: `subagent: no child agent registered for "${call.name}"`, code: "unknown_subagent" } };
    }

    const outcome = await driveToCompletion<HarnessState>(child, resolved);
    switch (outcome.status) {
      case "finished":
        return {
          ok: true,
          value: {
            sessionId: child,
            status: "finished",
            ...(outcome.output !== undefined ? { output: outcome.output } : {}),
          },
        };
      case "parked":
        return { ok: true, value: { sessionId: child, status: "parked", wait: outcome.wait as unknown as Json } };
      case "exhausted":
        // Absorbed to {ok:true}: the child RAN but did not converge — a normal observation
        // for the parent model, NOT a transient infra fault to retry.
        return {
          ok: true,
          value: {
            sessionId: child,
            status: "exhausted",
            error: { message: `subagent did not finish within ${outcome.turns} turns` },
          },
        };
      case "aborted":
        // The only {ok:false}: an infra lease/seq loss. The child made no progress this
        // attempt, so a retry (via the parent's tool_error seam) is exactly right.
        return { ok: false, error: { message: `subagent aborted (${outcome.reason})`, code: "subagent_aborted" } };
    }
  };
}

function badRequest(detail: string): Outcome {
  return { ok: false, error: { message: `subagent: ${detail}`, code: "bad_subagent_request" } };
}
