// Cryptographic content-addressing for the verifiable journal (spec §3.1).
// THE only new home of node:crypto — @irisrun/core and @irisrun/audit stay
// Node-free. All structured preimages are `canonicalize(...)` of a JSON object
// (sorted keys → injective → no separator ambiguity); the record chain folds
// fixed-width sha256 hex (also injective). Recompute is authoritative: hashes
// are taken from the ACTUAL bytes, never trusted from the stored copies.
import { createHash } from "node:crypto";
import { canonicalize } from "@irisrun/core";
import type { Json } from "@irisrun/core";
import type { JournalExportV1 } from "./types.ts";

export const FORMAT = "iris-journal-export";
export const VERSION = 1;
export const ALGORITHM = "sha256/iris-journal-v1";

/** Lowercase hex SHA-256 of bytes or a UTF-8 string. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
export function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Genesis = sha256(canonicalize({ v, sessionId, defDigest, snapshot })). */
export function genesisHash(input: {
  sessionId: string;
  defDigest: string;
  snapshot: { upToSeq: number; hash: string } | null;
}): string {
  const preimage: Json = {
    v: "iris-journal-v1",
    sessionId: input.sessionId,
    defDigest: input.defDigest,
    snapshot: input.snapshot
      ? { upToSeq: input.snapshot.upToSeq, hash: input.snapshot.hash }
      : null,
  };
  return sha256Hex(canonicalize(preimage));
}

/** chain[0]=genesis; chain[i+1]=sha256(chain[i] + recordHash[i]); both operands
 *  are fixed-width 64-char sha256 hex, so concatenation is injective. */
export function chainHashOf(genesis: string, recordHashes: string[]): string {
  let acc = genesis;
  for (const h of recordHashes) acc = sha256Hex(acc + h);
  return acc;
}

/** The canonical addressing preimage STRING (spec §3.1) — exposed so the
 *  reproducibility-vector test can anchor on the exact bytes, not only the digest. */
export function addressingPreimage(input: {
  chainHash: string;
  complete: boolean;
  defDigest: string;
  range: { from: number; to: number } | null;
  recordCount: number;
  sessionId: string;
  snapshot: { hash: string; upToSeq: number } | null;
}): string {
  const preimage: Json = {
    algorithm: ALGORITHM,
    chainHash: input.chainHash,
    complete: input.complete,
    defDigest: input.defDigest,
    format: FORMAT,
    range: input.range,
    recordCount: input.recordCount,
    sessionId: input.sessionId,
    snapshot: input.snapshot
      ? { hash: input.snapshot.hash, upToSeq: input.snapshot.upToSeq }
      : null,
    version: VERSION,
  };
  return canonicalize(preimage);
}

export interface RecomputedDigests {
  recordHashes: string[];
  snapshotHash: string | null;
  chainHash: string;
  recordCount: number;
  preimage: string;
  contentDigest: string;
}

/** Authoritative recompute from raw bytes + addressing fields. Used by BOTH
 *  buildExport (to fill) and verifyExport (to check). May throw if a record's
 *  bytes are not canonical JSON — callers absorb it (verifyExport wraps). */
export function computeDigests(fields: {
  sessionId: string;
  defDigest: string;
  complete: boolean;
  range: { from: number; to: number } | null;
  snapshotBytes: Uint8Array | null;
  snapshotUpToSeq: number | null;
  recordBytes: Uint8Array[];
}): RecomputedDigests {
  const recordHashes = fields.recordBytes.map((b) => sha256Hex(b));
  const snapshotHash = fields.snapshotBytes ? sha256Hex(fields.snapshotBytes) : null;
  const snapMeta =
    fields.snapshotBytes && fields.snapshotUpToSeq !== null
      ? { upToSeq: fields.snapshotUpToSeq, hash: snapshotHash as string }
      : null;
  const genesis = genesisHash({
    sessionId: fields.sessionId,
    defDigest: fields.defDigest,
    snapshot: snapMeta,
  });
  const chainHash = chainHashOf(genesis, recordHashes);
  const recordCount = recordHashes.length;
  const preimage = addressingPreimage({
    chainHash,
    complete: fields.complete,
    defDigest: fields.defDigest,
    range: fields.range,
    recordCount,
    sessionId: fields.sessionId,
    snapshot: snapMeta ? { hash: snapMeta.hash, upToSeq: snapMeta.upToSeq } : null,
  });
  return { recordHashes, snapshotHash, chainHash, recordCount, preimage, contentDigest: sha256Hex(preimage) };
}

/** Recompute the authoritative digests straight from an export's raw bytesB64. */
export function recomputeFromExport(x: JournalExportV1): RecomputedDigests {
  return computeDigests({
    sessionId: x.sessionId,
    defDigest: x.defDigest,
    complete: x.complete,
    range: x.range,
    snapshotBytes: x.snapshot ? fromB64(x.snapshot.bytesB64) : null,
    snapshotUpToSeq: x.snapshot ? x.snapshot.upToSeq : null,
    recordBytes: x.records.map((r) => fromB64(r.bytesB64)),
  });
}
