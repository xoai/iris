// inspectSession (ADR-0009 inspect surface) — render a recorded session's
// decision/effect/marker timeline from a StateStore, keyed by the stable
// sessionId. READ-ONLY: it reads snapshot + journal, decodes, and summarizes; it
// never writes and nothing it derives re-enters replayed state (determinism). The
// governing digest is re-derived LOCALLY (snapshot-safely — the post-snapshot tail,
// mirroring pin.ts:latestRecord), so @irisrun/inspect deps @irisrun/core ONLY. The result
// is a pure function of the journal bytes → re-inspecting is byte-identical.
import { decode } from "@irisrun/core";
import type {
  StateStore,
  JournalRecord,
  RecordKind,
  EffectIntent,
  EffectResult,
  Decision,
  Marker,
  Json,
} from "@irisrun/core";

export interface InspectedRecord {
  seq: number;
  ts: number;
  defDigest: string;
  kind: RecordKind;
  summary: string;
  detail: Json;
}

export interface SessionInspection {
  sessionId: string;
  governingDigest: string | null;
  snapshotUpTo: number | null;
  records: InspectedRecord[];
  counts: { effects: number; results: number; markers: number; decisions: number };
  terminal: "finished" | "parked" | "open";
}

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

function terminalOf(records: InspectedRecord[]): "finished" | "parked" | "open" {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.kind !== "marker") continue;
    const m = (r.detail as { marker?: string }).marker;
    if (m === "finish") return "finished";
    if (m === "wait") return "parked";
  }
  return "open";
}

/** Inspect a recorded session. Pure over the journal; never writes. */
export async function inspectSession(store: StateStore, sessionId: string): Promise<SessionInspection> {
  const snap = await store.readLatestSnapshot(sessionId);
  const snapshotUpTo = snap ? snap.upToSeq : null;
  const rows = await store.readJournal(sessionId, (snap?.upToSeq ?? -1) + 1);

  const records: InspectedRecord[] = rows.map((row) => {
    const rec = decode(row.bytes) as unknown as JournalRecord;
    return {
      seq: rec.seq,
      ts: rec.ts,
      defDigest: rec.defDigest,
      kind: rec.kind,
      summary: summarize(rec),
      detail: rec.payload as unknown as Json,
    };
  });

  const counts = { effects: 0, results: 0, markers: 0, decisions: 0 };
  for (const r of records) {
    if (r.kind === "effect_intent") counts.effects += 1;
    else if (r.kind === "effect_result") counts.results += 1;
    else if (r.kind === "marker") counts.markers += 1;
    else if (r.kind === "decision") counts.decisions += 1;
  }

  // governing digest = the latest record's defDigest (snapshot-safe: the terminal
  // marker is committed after the snapshot seq, so it survives truncation). null
  // for a never-started session (empty tail + no snapshot).
  const governingDigest = records.length ? records[records.length - 1].defDigest : null;

  return { sessionId, governingDigest, snapshotUpTo, records, counts, terminal: terminalOf(records) };
}

/** A deterministic one-line-per-record text rendering. */
export function renderTimeline(inspection: SessionInspection): string {
  const head =
    `session ${inspection.sessionId} | digest ${inspection.governingDigest ?? "—"} | ` +
    `terminal ${inspection.terminal} | snapshot ${inspection.snapshotUpTo ?? "—"} | ` +
    `${inspection.records.length} record(s)`;
  const lines = inspection.records.map((r) => `#${r.seq} ${r.kind} ${r.summary}`);
  return [head, ...lines].join("\n");
}
