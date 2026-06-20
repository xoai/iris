// `iris audit` command logic (roadmap P2-8) — the testable unit (injected store).
// Renders a whole-session, compliance-grade audit (full retained journal +
// completeness) AND a replay-verification verdict. cli-main.ts wires the real sqlite
// store; the logic lives here so it is unit-tested with an injected StateStore.
//
// Reducer selection (C1): a faithful replay needs the reducer the session was
// recorded under. `iris chat` records INTERACTIVE sessions; `iris run/serve` record
// non-interactive ones. We auto-detect interactivity from the journal (a `user_recv`
// effect or a `{kind:"user"}` wait marker) and pick the matching harness reducer +
// initial. `iris run/serve/chat` set no program invariants, so this covers every
// --db-auditable session (the deploy-scaffolded worker's invariants are out of scope).
import { harnessProgram } from "@irisrun/core";
import type { StateStore, HarnessState, Reducer, Json } from "@irisrun/core";
import { auditSession, renderAudit, verifySession } from "@irisrun/audit";
import type { SessionAudit, VerifyResult } from "@irisrun/audit";

export interface CliAuditOptions {
  store: StateStore;
  sessionId: string;
  reducer?: Reducer<HarnessState>; // override auto-detection
  startState?: HarnessState; // override auto-detection
  interactive?: boolean; // override journal auto-detection
}

function isUserWait(detail: Json): boolean {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return false;
  const d = detail as { marker?: Json; wait?: Json };
  const wait = d.wait;
  return d.marker === "wait" && wait !== null && typeof wait === "object" && !Array.isArray(wait) && (wait as { kind?: Json }).kind === "user";
}

export async function cmdAudit(
  opts: CliAuditOptions,
): Promise<{ audit: SessionAudit; verify: VerifyResult; text: string }> {
  const audit = await auditSession(opts.store, opts.sessionId);

  const interactive =
    opts.interactive ??
    audit.records.some((r) => r.effectKind === "user_recv" || (r.kind === "marker" && isUserWait(r.detail)));
  const prog = harnessProgram({ messages: [] }, interactive ? { interactive: true } : undefined);
  const reducer = opts.reducer ?? prog.reducer;
  const startState = opts.startState ?? prog.initial;

  const verify = await verifySession(opts.store, opts.sessionId, reducer, {
    startState,
    complete: audit.complete,
  });

  const vline =
    `verify: ${verify.ok ? "OK" : "FAILED"} ` +
    `(well-formed:${verify.wellFormed}, replay-deterministic:${verify.replayDeterministic}, total:${verify.total})` +
    (verify.issues.length ? `; ${verify.issues.join("; ")}` : "");
  const text = `${renderAudit(audit)}\n${vline}`;

  return { audit, verify, text };
}
