// The journaled approval audit trail (roadmap P1-5, done-when #2). Pure read over a
// recorded session: every governed (or legacy) approval is already a journaled
// `signal_recv` effect result, so the audit is a projection of the journal — nothing
// new is stored.
//
// RETENTION CONTRACT (important): the trail is only as complete as the RETAINED
// journal. The engine snapshots and TRUNCATES the journal past each snapshot unless a
// turn runs with `keepHistory: true` (@irisrun/core engine.ts). So:
//   • `auditApprovals` reads the FULL retained journal (from seq 0) — it sees every
//     approval still on disk, INCLUDING ones before a snapshot boundary. For a
//     COMPLETE compliance trail across a long session, retain history (run governed
//     turns with keepHistory — see the CLI `keepHistory` option); a session that
//     truncates keeps only the surviving tail, and truncated approvals are gone.
//   • `approvalAudit(inspection)` projects whatever inspection it is given. Note that
//     `inspectSession` reads only the POST-snapshot tail, so it OMITS approvals before
//     the snapshot boundary even when history is retained — prefer `auditApprovals`
//     for a complete trail.
import { inspectSession } from "@irisrun/inspect";
import type { SessionInspection } from "@irisrun/inspect";
import { decode } from "@irisrun/core";
import type { StateStore, JournalRecord, Json } from "@irisrun/core";
import type { Principal } from "./identity.ts";

const HITL_PREFIX = "hitl:";

// One approval event as seen in the journal. Governed approvals carry full identity;
// legacy bare {approved} approvals leave the identity fields null.
export type ApprovalAuditEntry = {
  seq: number;
  ts: number;
  callId: string;
  tool: string | null;
  principal: Principal | null;
  intent: "approve" | "deny" | null;
  approved: boolean;
  authorized: boolean | null;
  reason: string | null;
};

// The minimal record shape the projection needs (satisfied by both InspectedRecord
// and a JournalRecord mapped to {seq, ts, kind, detail:payload}).
type AuditRow = { seq: number; ts: number; kind: string; detail: Json };

function asObject(v: Json): { [k: string]: Json } | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as { [k: string]: Json }) : null;
}

function asPrincipal(v: Json | undefined): Principal | null {
  const o = v === undefined ? null : asObject(v);
  return o && typeof o.id === "string" ? (o as Principal) : null;
}

/** Project an ordered approval trail from a set of journal rows. Pure. */
function projectApprovals(rows: ReadonlyArray<AuditRow>): ApprovalAuditEntry[] {
  // 1) hitl signal_recv intents → callId, keyed by effectId for the result join.
  const callIdByEffect = new Map<string, string>();
  for (const r of rows) {
    if (r.kind !== "effect_intent") continue;
    const p = asObject(r.detail);
    if (!p || p.effectKind !== "signal_recv" || typeof p.effectId !== "string") continue;
    const req = asObject(p.request);
    const name = req && typeof req.name === "string" ? req.name : null;
    if (name && name.startsWith(HITL_PREFIX)) callIdByEffect.set(p.effectId, name.slice(HITL_PREFIX.length));
  }

  // 2) project each matching effect_result's value (governed OR legacy bare {approved}).
  const entries: ApprovalAuditEntry[] = [];
  for (const r of rows) {
    if (r.kind !== "effect_result") continue;
    const p = asObject(r.detail);
    if (!p || typeof p.effectId !== "string" || !callIdByEffect.has(p.effectId)) continue;
    const callId = callIdByEffect.get(p.effectId) as string;
    const outcome = asObject(p.outcome);
    const ok = outcome ? outcome.ok === true : false;
    const v = ok && outcome ? asObject(outcome.value) : null;
    const action = v ? asObject(v.action) : null;
    entries.push({
      seq: r.seq,
      ts: r.ts,
      callId,
      tool: action && typeof action.name === "string" ? action.name : null,
      principal: v ? asPrincipal(v.principal) : null,
      intent: v && (v.intent === "approve" || v.intent === "deny") ? v.intent : null,
      approved: v ? v.approved === true : false,
      authorized: v && typeof v.authorized === "boolean" ? v.authorized : null,
      reason: v && typeof v.reason === "string" ? v.reason : ok ? null : "effect failed",
    });
  }
  // Records arrive in journal order; sort defensively so the trail is seq-ordered.
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

/** Project the approval trail from an already-inspected session. NOTE: an inspection
 *  covers only the post-snapshot tail (see the RETENTION CONTRACT above); for a
 *  complete trail prefer `auditApprovals`. Pure. */
export function approvalAudit(inspection: SessionInspection): ApprovalAuditEntry[] {
  return projectApprovals(inspection.records);
}

/** Read the FULL retained journal (from seq 0) and project the approval trail. This
 *  is the complete-trail entry point: it sees every approval still retained, including
 *  ones before a snapshot boundary (which `inspectSession` would omit). Completeness
 *  across truncation requires retained history (see the RETENTION CONTRACT above). */
export async function auditApprovals(store: StateStore, sessionId: string): Promise<ApprovalAuditEntry[]> {
  const rows = await store.readJournal(sessionId, 0);
  const records: AuditRow[] = rows.map((row) => {
    const rec = decode(row.bytes) as unknown as JournalRecord;
    return { seq: rec.seq, ts: rec.ts, kind: rec.kind, detail: rec.payload as unknown as Json };
  });
  return projectApprovals(records);
}

/** Deterministic one-line-per-entry rendering of an approval trail. */
export function renderApprovalAudit(entries: ApprovalAuditEntry[]): string {
  if (entries.length === 0) return "no approvals recorded";
  return entries
    .map((e) => {
      const who = e.principal ? e.principal.id : "—";
      const verdict = e.approved ? "APPROVED" : "skipped";
      return `#${e.seq} ${e.callId} ${e.tool ?? "?"} — ${verdict} by ${who} (intent:${e.intent ?? "?"}, authorized:${e.authorized ?? "?"})`;
    })
    .join("\n");
}
