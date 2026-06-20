// Pure replay. Reconstruct state by
// folding a journal suffix through the program's reducer. No I/O, no clock, no
// RNG — a pure function of (snapshot, suffix, reducer).
import type { Json } from "./json.ts";
import type { JournalRecord, EffectResult } from "./journal.ts";

export type Reducer<S extends Json> = (state: S, record: JournalRecord) => S;

/**
 * Fold `suffix` over `snapshot`.
 *
 * Rules:
 * - Every record (including `effect_intent`, which the reducer treats as a
 *   no-op) is folded, so replay sees the IDENTICAL record stream as live.
 * - At most ONE `effect_result` per `effectId` is folded (first wins); later
 *   duplicates — only possible from a pathological recovery race — are ignored,
 *   keeping replay a well-defined pure function with no double-apply.
 */
export function replay<S extends Json>(
  snapshot: S,
  suffix: JournalRecord[],
  reducer: Reducer<S>,
): S {
  let state = snapshot;
  const resolved = new Set<string>();
  for (const rec of suffix) {
    if (rec.kind === "effect_result") {
      const effId = (rec.payload as EffectResult).effectId;
      if (resolved.has(effId)) continue; // dedupe — fold at most one result per effectId
      resolved.add(effId);
    }
    state = reducer(state, rec);
  }
  return state;
}
