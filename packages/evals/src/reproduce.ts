// reproduce(): makes "reproducible evals" an EXPLICIT, provable
// feature, not just an implicit property. It runs an EvalCase N independent times
// (each `case.build()` is a fresh store + performers, index reset to 0 — the EvalCase
// contract) and proves byte-identical {score, status, FULL-journal digest} across
// runs. The journal digest is the strong claim: not only does the score match, the
// entire recorded session is byte-identical run-to-run. First divergence is located.
//
// PRECONDITION: the full-journal digest reads from seq 0, so it covers the COMPLETE
// journal only when the case does not truncate (the eval norm — short cases, default
// no snapshot, or keepHistory). If a case truncates, the digest covers the retained
// tail; the reproducibility verdict stays sound (both runs truncate identically).
import { runTurn, canonicalize, decode } from "@irisrun/core";
import type { Json, TurnOutcome } from "@irisrun/core";
import { inspectSession } from "@irisrun/inspect";
import type { EvalCase, Scorer, EvalResult } from "./evals.ts";

export type ReproReport = {
  name: string;
  reproducible: boolean; // every run byte-identical in {score, status, journalDigest}
  runs: number;
  result: EvalResult; // the canonical (run 0) result
  journalDigest: string; // short fnv1a-32 hex of canonicalize(run 0's retained journal)
  divergence?: { run: number; field: "score" | "status" | "journal" };
};

// A tiny pure FNV-1a (32-bit) hex hash — a short fingerprint, not a security hash.
// Inlined so @irisrun/evals adds no dependency (mirrors @irisrun/audit's fnv.ts).
function fnv1a32hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Run an EvalCase N≥2 times and prove byte-identical results. Deterministic given a
 *  deterministic case; locates the first divergence otherwise. */
export async function reproduce<S extends Json>(
  c: EvalCase<S>,
  scorer: Scorer<S>,
  opts?: { runs?: number },
): Promise<ReproReport> {
  const runs = Math.max(2, opts?.runs ?? 2); // reproducibility needs ≥2 runs
  const turns = c.turns ?? 1;

  let firstResult: EvalResult | null = null;
  let canonical: { score: string; status: string; journalDigest: string } | null = null;
  let divergence: ReproReport["divergence"] | undefined;

  for (let i = 0; i < runs; i++) {
    const { deps, sessionId } = c.build(); // FRESH store + performers (index resets to 0)
    let outcome: TurnOutcome<S> | null = null;
    for (let t = 0; t < turns; t++) outcome = await runTurn(deps, sessionId);

    const inspection = await inspectSession(deps.store, sessionId);
    const status = outcome ? outcome.status : "open";
    const score = outcome ? scorer(inspection, outcome) : null;
    const rows = await deps.store.readJournal(sessionId, 0); // full retained journal
    const journalDigest = fnv1a32hex(canonicalize(rows.map((r) => decode(r.bytes))));
    const sig = { score: canonicalize(score), status: canonicalize(status), journalDigest };

    if (i === 0) {
      firstResult = { name: c.name, score, status };
      canonical = sig;
    } else if (canonical) {
      // First divergence wins, in field-precedence order score → status → journal
      // (a run differing in several fields reports the first by this order).
      if (sig.score !== canonical.score) divergence = { run: i, field: "score" };
      else if (sig.status !== canonical.status) divergence = { run: i, field: "status" };
      else if (sig.journalDigest !== canonical.journalDigest) divergence = { run: i, field: "journal" };
      if (divergence) break;
    }
  }

  return {
    name: c.name,
    reproducible: divergence === undefined,
    runs,
    // firstResult/canonical are always set (runs ≥ 2 ⇒ the i===0 branch ran)
    result: firstResult as EvalResult,
    journalDigest: (canonical as { journalDigest: string }).journalDigest,
    divergence,
  };
}
