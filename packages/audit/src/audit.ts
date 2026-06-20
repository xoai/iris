// auditSession (roadmap P2-8): a whole-session, compliance-grade audit. UNLIKE
// `inspectSession` (which reads only the POST-snapshot tail), this reads the FULL
// retained journal from seq 0 — every effect intent/result, every marker — plus the
// governed approval trail (via @iris/auth's `auditApprovals`, also full-journal).
//
// COMPLETENESS (the load-bearing property, LRN:gotcha d8ddf8a1): the engine snapshots
// and TRUNCATES the journal past each boundary unless a turn ran with `keepHistory:true`.
// A truncated session keeps only the surviving tail — so a compliance trail must report
// `complete:false` LOUDLY (with `truncatedBefore`) rather than silently dropping
// pre-snapshot events. `complete` ⇔ the retained journal still starts at seq 0.
//
// Pure over the journal bytes ⇒ re-auditing the same store is byte-identical.
import { decode } from "@iris/core";
import type {
  StateStore,
  JournalRecord,
  RecordKind,
  EffectKind,
  EffectIntent,
  EffectResult,
  Decision,
  Marker,
  Json,
} from "@iris/core";
import { auditApprovals, renderApprovalAudit } from "@iris/auth";
import type { ApprovalAuditEntry } from "@iris/auth";

/** One journal record, audit-projected. A superset of inspect's InspectedRecord:
 *  effect entries carry typed `effectKind`/`effectId`/`outcome` so a compliance
 *  reader sees what each effect was, while `detail` retains the raw payload. */
export type AuditEntry = {
  seq: number;
  ts: number; // audit/observability metadata only — never logic (journal.ts contract)
  defDigest: string;
  kind: RecordKind;
  effectKind?: EffectKind; // present for effect_intent
  effectId?: string; // present for effect_intent / effect_result
  outcome?: "ok" | "error"; // present for effect_result
  summary: string;
  detail: Json;
};

export type SessionAudit = {
  sessionId: string;
  governingDigest: string | null;
  terminal: "finished" | "parked" | "open";
  // completeness (LRN:gotcha d8ddf8a1)
  complete: boolean; // true ⇔ full history retained from seq 0 (or a never-started session)
  firstRetainedSeq: number; // 0 when complete; >0 when a snapshot truncated the prefix
  truncatedBefore: number | null; // = firstRetainedSeq when !complete, else null
  snapshotUpTo: number | null;
  // the trail
  records: AuditEntry[];
  approvals: ApprovalAuditEntry[];
  counts: { effects: number; results: number; markers: number; decisions: number };
};

// Deterministic one-line summary per record (mirrors @iris/inspect's private summarize
// so audit and inspect renderings read alike).
function summarize(rec: JournalRecord): string {
  switch (rec.kind) {
    case "effect_intent": {
      const p = rec.payload as EffectIntent;
      return `effect ${p.effectKind} (intent ${p.effectId}${p.retrySafe ? "" : ", retry-unsafe"})`;
    }
    case "effect_result": {
      const p = rec.payload as EffectResult;
      return `result ${p.effectId} → ${p.outcome.ok ? "ok" : `error: ${p.outcome.error.message}`}`;
    }
    case "decision": {
      const p = rec.payload as Decision;
      return `decision ${p.seam} → ${p.tacticId}`;
    }
    case "marker": {
      const p = rec.payload as Marker;
      if (p.marker === "wait") return `marker wait (${p.wait.kind}${p.wait.kind === "signal" ? `:${p.wait.name}` : ""})`;
      if (p.marker === "finish") return "marker finish";
      if (p.marker === "upgraded") return `marker upgraded ${p.from}→${p.to} @${p.atTurn}`;
      if (p.marker === "snapshot") return `marker snapshot upTo ${p.upToSeq}`;
      return `marker ${(p as { marker: string }).marker}`;
    }
    default:
      return rec.kind;
  }
}

function toEntry(rec: JournalRecord): AuditEntry {
  const base: AuditEntry = {
    seq: rec.seq,
    ts: rec.ts,
    defDigest: rec.defDigest,
    kind: rec.kind,
    summary: summarize(rec),
    detail: rec.payload as unknown as Json,
  };
  if (rec.kind === "effect_intent") {
    const p = rec.payload as EffectIntent;
    base.effectKind = p.effectKind;
    base.effectId = p.effectId;
  } else if (rec.kind === "effect_result") {
    const p = rec.payload as EffectResult;
    base.effectId = p.effectId;
    base.outcome = p.outcome.ok ? "ok" : "error";
  }
  return base;
}

function terminalOf(records: AuditEntry[]): "finished" | "parked" | "open" {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.kind !== "marker") continue;
    const m = (r.detail as { marker?: string }).marker;
    if (m === "finish") return "finished";
    if (m === "wait") return "parked";
  }
  return "open";
}

/** Audit a recorded session over its FULL retained journal. Pure read; never writes. */
export async function auditSession(store: StateStore, sessionId: string): Promise<SessionAudit> {
  const rows = await store.readJournal(sessionId, 0); // FULL retained journal — NOT inspectSession's tail
  const snap = await store.readLatestSnapshot(sessionId);
  const snapshotUpTo = snap ? snap.upToSeq : null;

  const records = rows.map((row) => toEntry(decode(row.bytes) as unknown as JournalRecord));

  // completeness: the retained journal still starts at seq 0 (or nothing was ever
  // recorded). A snapshot+truncate leaves the surviving tail starting at boundary+1.
  const firstRetainedSeq = rows.length ? rows[0].seq : snap ? snap.upToSeq + 1 : 0;
  const complete = rows.length === 0 ? snap === null : rows[0].seq === 0;
  const truncatedBefore = complete ? null : firstRetainedSeq;

  const counts = { effects: 0, results: 0, markers: 0, decisions: 0 };
  for (const r of records) {
    if (r.kind === "effect_intent") counts.effects += 1;
    else if (r.kind === "effect_result") counts.results += 1;
    else if (r.kind === "marker") counts.markers += 1;
    else if (r.kind === "decision") counts.decisions += 1;
  }

  const governingDigest = records.length ? records[records.length - 1].defDigest : null;
  const approvals = await auditApprovals(store, sessionId); // full-journal approval trail

  return {
    sessionId,
    governingDigest,
    terminal: terminalOf(records),
    complete,
    firstRetainedSeq,
    truncatedBefore,
    snapshotUpTo,
    records,
    approvals,
    counts,
  };
}

/** Deterministic, human-first compliance report over a SessionAudit. */
export function renderAudit(audit: SessionAudit): string {
  const completeness = audit.complete
    ? "COMPLETE"
    : `PARTIAL (truncated before #${audit.firstRetainedSeq}; re-run with keepHistory:true for a complete trail)`;
  const header =
    `session ${audit.sessionId} | digest ${audit.governingDigest ?? "—"} | ` +
    `terminal ${audit.terminal} | snapshot ${audit.snapshotUpTo ?? "—"} | ` +
    `${audit.records.length} record(s) | ${completeness} | ${audit.approvals.length} approval(s)`;
  const lines = audit.records.map((r) => `  #${r.seq} ${r.kind} ${r.summary}`);
  const approvalsBlock = renderApprovalAudit(audit.approvals)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return [header, ...lines, "approvals:", approvalsBlock].join("\n");
}
