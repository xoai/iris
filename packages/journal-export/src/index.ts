// @irisrun/journal-export — verifiable, portable, content-addressed journals.
// A self-contained export of a session (snapshot + journal tail) with a
// SHA-256 content address + tamper-evident hash chain, two-tier verification,
// and cross-host import. The ONLY new home of node:crypto — @irisrun/core and
// @irisrun/audit stay Node-free (edge/WASM-reachable). See
// docs/verifiable-journal-spec.md.
export const PACKAGE = "@irisrun/journal-export";

export type { JournalExportV1, ExportRecord, ExportSnapshot } from "./types.ts";
export {
  sha256Hex,
  toB64,
  fromB64,
  genesisHash,
  chainHashOf,
  addressingPreimage,
  computeDigests,
  recomputeFromExport,
  FORMAT,
  VERSION,
  ALGORITHM,
} from "./content-address.ts";
export type { RecomputedDigests } from "./content-address.ts";
export { buildExport, encodeExport, decodeExport, exportSession } from "./export.ts";
export { importSession } from "./import.ts";
export type { ImportResult } from "./import.ts";
export { verifyExport } from "./verify-export.ts";
export type { ExportVerifyResult } from "./verify-export.ts";
