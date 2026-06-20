// The replay-consistency assertion — the
// primary defense against determinism bugs. After every committed step, the
// engine re-runs replay and asserts byte-equality with live state.
//
// This module is PURE: it always asserts when called. WHETHER to call it is the
// engine's decision (deps.assertReplay), set by the runner from IRIS_ASSERT —
// core never reads process.env (Node-only; would break edge-reachability).
import type { Json } from "./json.ts";
import type { JournalRecord } from "./journal.ts";
import type { Reducer } from "./replay.ts";
import { replay } from "./replay.ts";
import { canonicalize } from "./json.ts";

export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * Throw `ReplayDivergenceError` if replaying `suffix` from `snapshot` does not
 * byte-equal `liveState`. No silent pass — a divergence fails the build.
 */
export function assertReplayConsistency<S extends Json>(
  liveState: S,
  snapshot: S,
  suffix: JournalRecord[],
  reducer: Reducer<S>,
): void {
  const reconstructed = canonicalize(replay(snapshot, suffix, reducer));
  const live = canonicalize(liveState);
  if (reconstructed !== live) {
    throw new ReplayDivergenceError(
      `replay-consistency violated: reconstructed state != live state\n` +
        `  replay: ${reconstructed}\n` +
        `  live:   ${live}`,
    );
  }
}
