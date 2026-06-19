// Snapshot trigger policy (spec §3.7). Snapshots bound replay cost; the engine
// calls this only AFTER a complete effect or a marker, so a snapshot boundary
// never bisects an effect_intent/effect_result pair.
export function shouldSnapshot(
  currentSeq: number,
  lastSnapshotSeq: number,
  threshold: number,
): boolean {
  return threshold > 0 && currentSeq - lastSnapshotSeq >= threshold;
}

export const DEFAULT_SNAPSHOT_THRESHOLD = 64;
