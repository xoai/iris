// Test helpers for building journal records by hand.
import type {
  JournalRecord,
  RecordKind,
  RecordPayload,
  Json,
} from "@iris/core";

const DIGEST = "sha256:test-image";

export function rec(
  seq: number,
  kind: RecordKind,
  payload: RecordPayload,
  ts = seq,
): JournalRecord {
  return { seq, ts, defDigest: DIGEST, kind, payload };
}

export function intentRec(
  seq: number,
  effectId: string,
  effectKind: "clock" | "echo",
  request: Json,
): JournalRecord {
  return rec(seq, "effect_intent", {
    effectId,
    effectKind,
    request,
    retrySafe: true,
  });
}

export function resultRec(
  seq: number,
  effectId: string,
  value: Json,
): JournalRecord {
  return rec(seq, "effect_result", { effectId, outcome: { ok: true, value } });
}
