// `iris journal export|verify|import` command logic — the verifiable portable
// journal. The TESTABLE units (injected store / raw bytes);
// cli-main.ts's journalCommand wires real sqlite + fs IO and is not unit-tested
// per repo convention. NOTE: `iris verify` already means OCI image verification,
// so these live under the `journal` subcommand group.
//
// Reducer selection for Tier-2 replay mirrors cmdAudit (C1): the reducer is core
// harness code (harnessProgram), interactivity auto-detected from the journal —
// NOT from any image. The image only binds the defDigest PIN (lock.imageDigest).
import { harnessProgram, decode } from "@irisrun/core";
import type { StateStore, HarnessState, Reducer, Json, JournalRecord, EffectIntent } from "@irisrun/core";
import {
  exportSession,
  importSession,
  encodeExport,
  decodeExport,
  verifyExport,
  fromB64,
} from "@irisrun/journal-export";
import type { JournalExportV1, ExportVerifyResult, ImportResult } from "@irisrun/journal-export";

export interface CliJournalExportOptions {
  store: StateStore;
  sessionId: string;
}
export interface CliJournalExportResult {
  ok: true;
  exitCode: 0;
  bytes: Uint8Array;
  export: JournalExportV1;
  text: string;
}
export async function cmdJournalExport(opts: CliJournalExportOptions): Promise<CliJournalExportResult> {
  const x = await exportSession(opts.store, opts.sessionId);
  const bytes = encodeExport(x);
  const text =
    `exported session '${opts.sessionId}': ${x.records.length} records` +
    `${x.snapshot ? ` + snapshot@${x.snapshot.upToSeq}` : ""}, complete=${x.complete}\n` +
    `contentDigest ${x.contentDigest}`;
  return { ok: true, exitCode: 0, bytes, export: x, text };
}

export interface CliJournalVerifyOptions {
  bytes: Uint8Array;
  replay?: boolean;
  expectDefDigest?: string; // from --image (lock.imageDigest)
  reducer?: Reducer<HarnessState>; // override auto-detection
  startState?: HarnessState; // override auto-detection
  interactive?: boolean; // override journal auto-detection
}
export interface CliJournalVerifyResult {
  ok: boolean;
  exitCode: 0 | 1;
  result: ExportVerifyResult;
  text: string;
}

function detectInteractive(x: JournalExportV1): boolean {
  for (const r of x.records) {
    let rec: JournalRecord;
    try {
      rec = decode(fromB64(r.bytesB64)) as unknown as JournalRecord;
    } catch {
      continue;
    }
    if (rec.kind === "effect_intent" && (rec.payload as EffectIntent).effectKind === "user_recv") return true;
    if (rec.kind === "marker") {
      const m = rec.payload as { marker?: Json; wait?: { kind?: Json } };
      if (m.marker === "wait" && m.wait !== undefined && m.wait.kind === "user") return true;
    }
  }
  return false;
}

export function cmdJournalVerify(opts: CliJournalVerifyOptions): CliJournalVerifyResult {
  const verifyOpts: { reducer?: Reducer<HarnessState>; startState?: HarnessState; expectDefDigest?: string } = {};
  if (opts.expectDefDigest !== undefined) verifyOpts.expectDefDigest = opts.expectDefDigest;
  if (opts.replay) {
    let interactive = opts.interactive;
    let hasSnapshot = false;
    try {
      const x = decodeExport(opts.bytes);
      hasSnapshot = x.snapshot !== null;
      if (interactive === undefined) interactive = detectInteractive(x);
    } catch {
      // garbage bytes — verifyExport returns ok:false; the reducer is irrelevant.
    }
    const prog = harnessProgram({ messages: [] }, interactive ? { interactive: true } : undefined);
    verifyOpts.reducer = opts.reducer ?? prog.reducer;
    // Only override startState when there is NO snapshot (else verifyExport uses
    // the snapshot state). For a no-snapshot session the harness initial is the start.
    const start = opts.startState ?? (hasSnapshot ? undefined : prog.initial);
    if (start !== undefined) verifyOpts.startState = start;
  }
  const result = verifyExport(opts.bytes, verifyOpts);
  return { ok: result.ok, exitCode: result.ok ? 0 : 1, result, text: renderVerify(result) };
}

function renderVerify(r: ExportVerifyResult): string {
  const lines = [
    `journal verify: ${r.ok ? "OK" : "FAILED"}`,
    `  session      ${r.sessionId || "(unknown)"}`,
    `  content-addr ${r.contentAddress.ok ? "OK" : "FAILED"} (${r.contentAddress.actualDigest || "?"})`,
    `  structure    ${r.structural.ok ? "OK" : "FAILED"} (complete=${r.structural.complete})`,
  ];
  if (r.replay) {
    lines.push(
      `  replay       ${r.replay.ok ? "OK" : "FAILED"} ` +
        `(deterministic=${r.replay.replayDeterministic}, total=${r.replay.total}; finalState ${r.finalStateDigest})`,
    );
  }
  if (r.issues.length) lines.push(`  issues: ${r.issues.join("; ")}`);
  return lines.join("\n");
}

export interface CliJournalImportOptions {
  store: StateStore;
  bytes: Uint8Array;
}
export interface CliJournalImportResult {
  ok: true;
  exitCode: 0;
  sessionId: string;
  result: ImportResult;
  text: string;
}
export async function cmdJournalImport(opts: CliJournalImportOptions): Promise<CliJournalImportResult> {
  const x = decodeExport(opts.bytes);
  const result = await importSession(opts.store, x);
  const text =
    `imported session '${x.sessionId}': ${result.records} records` +
    `${result.snapshotUpTo !== null ? ` + snapshot@${result.snapshotUpTo}` : ""}`;
  return { ok: true, exitCode: 0, sessionId: x.sessionId, result, text };
}
