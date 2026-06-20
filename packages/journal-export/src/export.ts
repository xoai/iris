// Build / serialize / parse the portable export file (spec §3, §4).
import { encode, decode } from "@irisrun/core";
import type { Json, JournalRecord, StateStore } from "@irisrun/core";
import type { JournalExportV1 } from "./types.ts";
import { ALGORITHM, FORMAT, VERSION, computeDigests, toB64 } from "./content-address.ts";

/** Assemble a fully content-addressed export from raw snapshot + record bytes.
 *  Pure — no store I/O (exportSession in import-export.ts supplies the bytes). */
export function buildExport(parts: {
  sessionId: string;
  defDigest: string;
  complete: boolean;
  snapshot: { upToSeq: number; bytes: Uint8Array } | null;
  records: Array<{ seq: number; bytes: Uint8Array }>;
}): JournalExportV1 {
  const range = parts.records.length
    ? { from: parts.records[0].seq, to: parts.records[parts.records.length - 1].seq }
    : null;
  const d = computeDigests({
    sessionId: parts.sessionId,
    defDigest: parts.defDigest,
    complete: parts.complete,
    range,
    snapshotBytes: parts.snapshot ? parts.snapshot.bytes : null,
    snapshotUpToSeq: parts.snapshot ? parts.snapshot.upToSeq : null,
    recordBytes: parts.records.map((r) => r.bytes),
  });
  return {
    format: FORMAT,
    version: VERSION,
    algorithm: ALGORITHM,
    sessionId: parts.sessionId,
    defDigest: parts.defDigest,
    complete: parts.complete,
    range,
    snapshot: parts.snapshot
      ? { upToSeq: parts.snapshot.upToSeq, bytesB64: toB64(parts.snapshot.bytes), hash: d.snapshotHash as string }
      : null,
    records: parts.records.map((r, i) => ({ seq: r.seq, bytesB64: toB64(r.bytes), hash: d.recordHashes[i] })),
    chainHash: d.chainHash,
    contentDigest: d.contentDigest,
  };
}

/** Export a recorded session from a StateStore to a portable, content-addressed
 *  file model. Mirrors verifySession's replay window: snapshot + tail from
 *  snapUpTo+1, with the §3.0 `complete` rule computed from the FULL journal. */
export async function exportSession(store: StateStore, sessionId: string): Promise<JournalExportV1> {
  const snap = await store.readLatestSnapshot(sessionId);
  const snapUpTo = snap ? snap.upToSeq : -1;
  const tail = await store.readJournal(sessionId, snapUpTo + 1);
  // §3.0 — mirror verifySession exactly (full[0].seq===0 vs snap===null).
  const full = await store.readJournal(sessionId, 0);
  const complete = full.length === 0 ? snap === null : full[0].seq === 0;
  // Governing digest = last included record's defDigest ("" when 0 records).
  let defDigest = "";
  if (tail.length) {
    defDigest = (decode(tail[tail.length - 1].bytes) as unknown as JournalRecord).defDigest;
  }
  return buildExport({
    sessionId,
    defDigest,
    complete,
    snapshot: snap ? { upToSeq: snap.upToSeq, bytes: snap.bytes } : null,
    records: tail.map((r) => ({ seq: r.seq, bytes: r.bytes })),
  });
}

/** Serialize to the on-disk file bytes (canonical JSON, UTF-8). */
export function encodeExport(x: JournalExportV1): Uint8Array {
  return encode(x as unknown as Json);
}

/** Parse file bytes back to the export object. Throws on non-JSON (verifyExport wraps it). */
export function decodeExport(bytes: Uint8Array): JournalExportV1 {
  return decode(bytes) as unknown as JournalExportV1;
}
