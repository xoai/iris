// Two-tier verification of a portable export. NEVER throws — any bad
// input (non-JSON envelope, non-canonical/Infinity record payload, base64
// failure) becomes ok:false with a named issue. Tier 1 (content-address +
// structure + canonical-bytes) needs ONLY the file. Tier 2 (replay-determinism)
// additionally needs a caller-supplied reducer.
import { encode, decode } from "@irisrun/core";
import type { Json, JournalRecord, Reducer } from "@irisrun/core";
import { verifyStructure, verifyReplay } from "@irisrun/audit";
import type { VerifyResult } from "@irisrun/audit";
import type { JournalExportV1 } from "./types.ts";
import { ALGORITHM, FORMAT, VERSION, fromB64, recomputeFromExport } from "./content-address.ts";
import { decodeExport } from "./export.ts";

export interface ExportVerifyResult {
  ok: boolean;
  sessionId: string;
  defDigest: string;
  range: { from: number; to: number } | null;
  contentAddress: { ok: boolean; expectedDigest: string; actualDigest: string; issues: string[] };
  structural: { ok: boolean; complete: boolean; issues: string[] };
  replay?: VerifyResult;
  finalStateDigest?: string | null;
  issues: string[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function fail(msg: string): ExportVerifyResult {
  return {
    ok: false,
    sessionId: "",
    defDigest: "",
    range: null,
    contentAddress: { ok: false, expectedDigest: "", actualDigest: "", issues: [msg] },
    structural: { ok: false, complete: false, issues: [] },
    issues: [msg],
  };
}

/** Verify an export's bytes. Tier 1 always; Tier 2 when `opts.reducer` is given.
 *  `opts.expectDefDigest` is an optional PIN check (skipped when the file has no
 *  governing digest). The reducer is CALLER-supplied — never derived from any image. */
export function verifyExport<S extends Json>(
  bytes: Uint8Array,
  opts: { reducer?: Reducer<S>; startState?: S; expectDefDigest?: string } = {},
): ExportVerifyResult {
  let x: JournalExportV1;
  try {
    x = decodeExport(bytes);
  } catch (e) {
    return fail(`not a valid iris-journal-export: ${errMsg(e)}`);
  }
  try {
    if (x === null || typeof x !== "object" || !Array.isArray(x.records)) {
      return fail("malformed: not an iris-journal-export object");
    }
    const caIssues: string[] = [];
    if (x.format !== FORMAT) caIssues.push(`unexpected format ${JSON.stringify(x.format)}`);
    if (x.version !== VERSION) caIssues.push(`unexpected version ${JSON.stringify(x.version)}`);
    if (x.algorithm !== ALGORITHM) caIssues.push(`unexpected algorithm ${JSON.stringify(x.algorithm)}`);

    // Content-address: recompute authoritatively from the raw bytesB64 (hashing
    // raw bytes never throws on a malformed payload).
    const recomputed = recomputeFromExport(x);
    if (recomputed.contentDigest !== x.contentDigest) {
      caIssues.push(`content digest mismatch: stored ${x.contentDigest}, recomputed ${recomputed.contentDigest}`);
    }
    if (recomputed.chainHash !== x.chainHash) {
      caIssues.push(`chain hash mismatch: stored ${x.chainHash}, recomputed ${recomputed.chainHash}`);
    }
    for (let i = 0; i < x.records.length; i++) {
      if (x.records[i].hash !== recomputed.recordHashes[i]) {
        caIssues.push(`record #${x.records[i].seq} (index ${i}) stored hash does not match its bytes`);
        break;
      }
    }
    if (x.snapshot && recomputed.snapshotHash !== x.snapshot.hash) {
      caIssues.push("snapshot stored hash does not match its bytes");
    }

    // Canonical-bytes check (step 2b) + decode for structural/replay. Per-item
    // try/catch absorbs a malformed payload (the Infinity case JSON.parse does
    // NOT throw on, but encode/canonicalize does) into a named issue.
    const records: JournalRecord[] = [];
    let decodeOk = true;
    for (const r of x.records) {
      try {
        const raw = fromB64(r.bytesB64);
        const decoded = decode(raw) as unknown as JournalRecord;
        if (!bytesEqual(encode(decoded as unknown as Json), raw)) {
          caIssues.push(`record #${r.seq} bytes are not canonical`);
        }
        records.push(decoded);
      } catch (e) {
        caIssues.push(`record #${r.seq} payload is not canonical JSON: ${errMsg(e)}`);
        decodeOk = false;
      }
    }
    if (x.snapshot) {
      try {
        const raw = fromB64(x.snapshot.bytesB64);
        if (!bytesEqual(encode(decode(raw) as unknown as Json), raw)) {
          caIssues.push("snapshot bytes are not canonical");
        }
      } catch (e) {
        caIssues.push(`snapshot payload is not canonical JSON: ${errMsg(e)}`);
        decodeOk = false;
      }
    }

    const contentAddress = {
      ok: caIssues.length === 0,
      expectedDigest: x.contentDigest,
      actualDigest: recomputed.contentDigest,
      issues: caIssues,
    };

    // Structural (reducer-free) — only when all records decoded.
    const structIssues: string[] = [];
    let complete = x.complete;
    if (decodeOk) {
      const rowSeqs = x.records.map((r) => r.seq);
      const struct = verifyStructure(records, { complete: x.complete, rowSeqs });
      complete = struct.complete;
      structIssues.push(...struct.issues);
      const expectedRange = records.length
        ? { from: x.records[0].seq, to: x.records[x.records.length - 1].seq }
        : null;
      if (JSON.stringify(x.range) !== JSON.stringify(expectedRange)) {
        structIssues.push(`range ${JSON.stringify(x.range)} does not match records ${JSON.stringify(expectedRange)}`);
      }
      if (x.complete && records.length && x.range) {
        const wantFrom = x.snapshot ? x.snapshot.upToSeq + 1 : 0;
        if (x.range.from !== wantFrom) {
          structIssues.push(`complete export must start at seq ${wantFrom}, got ${x.range.from}`);
        }
      }
    } else {
      structIssues.push("structural check skipped: a record payload failed to decode");
    }
    // PIN check (skipped when the file carries no governing digest).
    if (opts.expectDefDigest !== undefined && x.defDigest !== "" && opts.expectDefDigest !== x.defDigest) {
      structIssues.push(`defDigest pin mismatch: file ${x.defDigest}, expected ${opts.expectDefDigest}`);
    }
    const structural = { ok: structIssues.length === 0, complete, issues: structIssues };

    // Tier 2: replay-determinism (caller-supplied reducer).
    let replay: VerifyResult | undefined;
    let finalStateDigest: string | null | undefined;
    if (opts.reducer && decodeOk) {
      const startState = (opts.startState ??
        (x.snapshot ? (decode(fromB64(x.snapshot.bytesB64)) as unknown as S) : (null as unknown as S))) as S;
      const rowSeqs = x.records.map((r) => r.seq);
      replay = verifyReplay(opts.reducer, records, startState, { complete: x.complete, rowSeqs });
      finalStateDigest = replay.finalStateDigest;
    }

    const ok = contentAddress.ok && structural.ok && (replay ? replay.ok : true);
    const issues = [...contentAddress.issues, ...structural.issues, ...(replay ? replay.issues : [])];
    return {
      ok,
      sessionId: x.sessionId,
      defDigest: x.defDigest,
      range: x.range,
      contentAddress,
      structural,
      replay,
      finalStateDigest,
      issues,
    };
  } catch (e) {
    return fail(`verify error: ${errMsg(e)}`);
  }
}
