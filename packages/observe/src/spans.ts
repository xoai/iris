// OTel-shaped spans derived from a recorded session's inspection. A root `turn`
// span parents one child span per effect (intent→result) and one per marker.
// spanIds are DETERMINISTIC (sessionId#seq — no RNG, so re-spanning is
// byte-identical). Timing reads record.ts — legitimate here (observability); the
// determinism contract (journal.ts) forbids only reducers/step from reading ts.
// Spans are derived from the journal and NEVER fed back into replayed state, so a
// turn that was observed still replays byte-identically. A Sink decouples emission
// from a backend (collecting/console here; real OTLP export is a manual smoke).
import type { Json } from "@irisrun/core";
import type { SessionInspection } from "@irisrun/inspect";

export type SpanStatus = "OK" | "ERROR" | "UNSET";

export interface Span {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, Json>;
  statusCode: SpanStatus;
}

export interface Sink {
  export(spans: Span[]): void | Promise<void>;
}

/** A test/in-memory sink that accumulates exported spans. */
export function collectingSink(): { sink: Sink; spans: Span[] } {
  const spans: Span[] = [];
  return { spans, sink: { export: (s) => void spans.push(...s) } };
}

/** A sink that prints one JSON span per line (a stand-in for a real exporter). */
export function consoleSink(): Sink {
  return {
    export(spans: Span[]): void {
      for (const s of spans) console.log(JSON.stringify(s));
    },
  };
}

/** Derive OTel-shaped spans from a session inspection. Pure + deterministic. */
export function toSpans(inspection: SessionInspection): Span[] {
  const sid = inspection.sessionId;
  const recs = inspection.records;
  const rootId = `${sid}#turn`;
  const first = recs.length ? recs[0].ts : 0;
  const last = recs.length ? recs[recs.length - 1].ts : 0;

  const spans: Span[] = [
    {
      name: "turn",
      spanId: rootId,
      startTimeUnixNano: first,
      endTimeUnixNano: last,
      attributes: {
        sessionId: sid,
        governingDigest: inspection.governingDigest,
        terminal: inspection.terminal,
        records: recs.length,
      },
      statusCode: inspection.terminal === "finished" ? "OK" : "UNSET",
    },
  ];

  // index effect results by effectId so an intent span can carry its outcome
  const results = new Map<string, { ts: number; ok: boolean }>();
  for (const r of recs) {
    if (r.kind === "effect_result") {
      const d = r.detail as { effectId: string; outcome: { ok: boolean } };
      results.set(d.effectId, { ts: r.ts, ok: d.outcome.ok });
    }
  }

  for (const r of recs) {
    if (r.kind === "effect_intent") {
      const d = r.detail as { effectId: string; effectKind: string };
      const res = results.get(d.effectId);
      spans.push({
        name: `effect:${d.effectKind}`,
        spanId: `${sid}#${r.seq}`,
        parentSpanId: rootId,
        startTimeUnixNano: r.ts,
        endTimeUnixNano: res ? res.ts : r.ts,
        attributes: { effectId: d.effectId, effectKind: d.effectKind, seq: r.seq },
        statusCode: res ? (res.ok ? "OK" : "ERROR") : "UNSET",
      });
    } else if (r.kind === "marker") {
      const m = (r.detail as { marker: string }).marker;
      spans.push({
        name: `marker:${m}`,
        spanId: `${sid}#${r.seq}`,
        parentSpanId: rootId,
        startTimeUnixNano: r.ts,
        endTimeUnixNano: r.ts,
        attributes: { marker: m, seq: r.seq },
        statusCode: "OK",
      });
    }
  }

  return spans;
}
