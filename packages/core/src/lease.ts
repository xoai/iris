// Single-writer lease over StateStore.cas. The returned monotonic
// Version is the FENCE. Mutual exclusion is enforced not at acquire time but by
// FENCING: a taken-over old holder is rejected by the store's fenced append
// (stale_fence). This is the robust fencing-token model — acquire-time locking
// alone cannot survive partitions.
import type { StateStore, Version } from "./ports.ts";
import { encode } from "./json.ts";

export type LeaseResult =
  | { ok: true; fence: Version }
  | { ok: false; current: Version };

/**
 * Acquire (or take over) the session lease. Reads the current lease version and
 * compare-and-swaps to claim it; the new version is the fence that tags every
 * subsequent append. A cas race (two simultaneous acquirers) yields
 * `{ ok: false, current }` for the loser.
 */
export async function acquireLease(
  store: StateStore,
  sessionId: string,
  holderId: string,
  expiresAt = 0,
): Promise<LeaseResult> {
  const key = `lease:${sessionId}`;
  const existing = await store.load(key);
  const expected = existing ? existing.version : null;
  const r = await store.cas(key, expected, encode({ holder: holderId, expiresAt }));
  return r.ok ? { ok: true, fence: r.version } : { ok: false, current: r.current };
}

/**
 * Release the lease. A no-op for correctness: stale writes are already rejected
 * by fencing, and the next holder takes over via `acquireLease`. Kept as a hook
 * for future TTL handling.
 */
export async function releaseLease(
  _store: StateStore,
  _sessionId: string,
  _fence: Version,
): Promise<void> {
  // intentionally empty — see doc comment
}
