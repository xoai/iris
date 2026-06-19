// Deterministic effect identity (spec §3.4, framework Spec 01 §4).
import type { EffectKind } from "./journal.ts";

/**
 * Derive an effectId from the COMMITTED seq of the intent record and its kind.
 * Seq is dense and strictly monotonic per session, so the id is collision-free
 * even without the kind prefix (kept for readability).
 *
 * The engine must only treat an intent as committed when append returns this
 * exact seq; on recovery the effectId is READ FROM THE STORED INTENT, never
 * recomputed from a predicted seq (spec §3.4).
 */
export function effectId(seq: number, kind: EffectKind): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(
      `effectId: seq must be a non-negative integer, got ${String(seq)}`,
    );
  }
  return `${kind}:${seq}`;
}
