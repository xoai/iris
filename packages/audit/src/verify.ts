// verifyReplay/verifySession: offline, compliance-grade verification
// of a recorded session. THREE SOUND GUARANTEES (and no more — honesty matters):
//  1. structural integrity (reducer-free, the strongest claim): dense monotonic seq;
//     each record's self-reported seq matches its store row position (corruption/
//     desync catch); ≤1 effect_result per effectId; and — only when the journal is
//     COMPLETE — every effect_result joins a prior effect_intent. (When the prefix
//     was truncated, an orphan result is legitimate and NOT flagged.)
//  2. in-process replay-determinism: fold the retained records twice and compare via
//     canonicalEqual. This proves the reducer is a pure function of its inputs IN
//     THIS PROCESS (catches mutable-shared-state / iteration-order bugs). It does NOT
//     prove the reducer never read a clock/RNG at record time — that is the ONLINE
//     `assertReplayConsistency` (engine.ts), run on every live step.
//  3. totality: replay does not throw.
// It deliberately does NOT claim snapshot-fidelity (that needs the original input,
// which is not journaled for no-snapshot sessions — see the initiative decisions).
import { replay, canonicalize, canonicalEqual, decode } from "@irisrun/core";
import type { Reducer, JournalRecord, EffectIntent, EffectResult, StateStore, Json } from "@irisrun/core";
import { fnv1a32hex } from "./fnv.ts";

export type VerifyResult = {
  ok: boolean; // wellFormed && replayDeterministic && total
  wellFormed: boolean;
  replayDeterministic: boolean;
  total: boolean;
  finalStateDigest: string | null; // short fnv1a-32 hex of canonicalize(state); null iff !total
  retainedRange: { from: number; to: number } | null;
  complete: boolean; // caveat surface: were structural intent-joins fully checkable?
  issues: string[]; // human-readable; empty ⇔ ok
};

/** The reducer-FREE structural core (guarantee #1). Checks dense/monotonic seq,
 *  self-seq vs store row position, ≤1 result per effectId, and — only when
 *  `complete` — that every result joins a prior intent (an orphan result in a
 *  truncated window is legitimate and NOT flagged). Pure; no reducer, no replay.
 *  Reused by @irisrun/journal-export's file-only (Tier 1) verification. */
export function verifyStructure(
  records: JournalRecord[],
  opts: { complete?: boolean; rowSeqs?: number[] } = {},
): { ok: boolean; complete: boolean; issues: string[] } {
  const complete = opts.complete ?? true;
  const structural: string[] = [];

  // (a) dense, monotonic seq within the retained range
  for (let i = 1; i < records.length; i++) {
    if (records[i].seq !== records[i - 1].seq + 1) {
      structural.push(`seq not dense at index ${i}: #${records[i - 1].seq} → #${records[i].seq}`);
    }
  }
  // (b) each record's self-reported seq matches its store row position
  if (opts.rowSeqs) {
    for (let i = 0; i < records.length; i++) {
      if (opts.rowSeqs[i] !== records[i].seq) {
        structural.push(`self-seq mismatch at index ${i}: record #${records[i].seq} stored at row position ${opts.rowSeqs[i]}`);
      }
    }
  }
  // (c) ≤1 effect_result per effectId; (d) when complete, every result joins a prior intent
  const seenResult = new Set<string>();
  const intentIds = new Set<string>();
  for (const r of records) {
    if (r.kind === "effect_intent") {
      intentIds.add((r.payload as EffectIntent).effectId);
    } else if (r.kind === "effect_result") {
      const id = (r.payload as EffectResult).effectId;
      if (seenResult.has(id)) structural.push(`duplicate effect_result for effectId ${id} (#${r.seq})`);
      seenResult.add(id);
      if (complete && !intentIds.has(id)) {
        structural.push(`effect_result for effectId ${id} (#${r.seq}) has no prior effect_intent`);
      }
    }
  }

  return { ok: structural.length === 0, complete, issues: structural };
}

/** Pure verification of a fold over `startState`. `records` is the retained tail to
 *  fold; `reducer` MUST match how the session was recorded (caller's responsibility).
 *  `opts.rowSeqs` are the store row positions for the self-seq integrity check. */
export function verifyReplay<S extends Json>(
  reducer: Reducer<S>,
  records: JournalRecord[],
  startState: S,
  opts: { complete?: boolean; firstSeq?: number; rowSeqs?: number[] } = {},
): VerifyResult {
  const retainedRange = records.length ? { from: records[0].seq, to: records[records.length - 1].seq } : null;

  // structural integrity (guarantee #1) — delegated to the reducer-free core.
  const struct = verifyStructure(records, { complete: opts.complete, rowSeqs: opts.rowSeqs });
  const complete = struct.complete;
  const wellFormed = struct.ok;
  const issues: string[] = [...struct.issues];

  // replay: in-process determinism (fold twice) + totality
  let total = true;
  let replayDeterministic = false;
  let finalStateDigest: string | null = null;
  try {
    const a = replay(startState, records, reducer);
    const b = replay(startState, records, reducer);
    replayDeterministic = canonicalEqual(a, b);
    if (!replayDeterministic) {
      issues.push("replay is not deterministic: two folds of the same records produced different state (in-process reducer nondeterminism)");
    }
    finalStateDigest = fnv1a32hex(canonicalize(a));
  } catch (e) {
    total = false;
    replayDeterministic = false;
    issues.push(`replay threw (not total): ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: wellFormed && replayDeterministic && total,
    wellFormed,
    replayDeterministic,
    total,
    finalStateDigest,
    retainedRange,
    complete,
    issues,
  };
}

/** Verify a recorded session from a StateStore. Mirrors the engine's live replay
 *  window (snapshot state + post-snapshot tail). The CALLER supplies the reducer
 *  matching the recording config (and, for a no-snapshot session, the program
 *  initial as `opts.startState`). */
export async function verifySession<S extends Json>(
  store: StateStore,
  sessionId: string,
  reducer: Reducer<S>,
  opts: { startState?: S; complete?: boolean } = {},
): Promise<VerifyResult> {
  const snap = await store.readLatestSnapshot(sessionId);
  const snapUpTo = snap ? snap.upToSeq : -1;
  const tailRows = await store.readJournal(sessionId, snapUpTo + 1);
  const tail = tailRows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const start = opts.startState ?? (snap ? (decode(snap.bytes) as unknown as S) : (null as unknown as S));

  let complete = opts.complete;
  if (complete === undefined) {
    const full = await store.readJournal(sessionId, 0);
    complete = full.length === 0 ? snap === null : full[0].seq === 0;
  }
  const firstSeq = tailRows.length ? tailRows[0].seq : snapUpTo + 1;
  return verifyReplay(reducer, tail, start, { complete, firstSeq, rowSeqs: tailRows.map((r) => r.seq) });
}
