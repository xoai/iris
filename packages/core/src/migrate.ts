// Cross-store session migration (spec §3.4). Copies a session from one
// StateStore to another using ONLY the StateStore port (which core owns), so it
// is host-agnostic and lives in core (reusable for the M-Proof cross-host demo).
import type { StateStore } from "./ports.ts";
import { acquireLease } from "./lease.ts";

export interface MigrateResult {
  records: number;
  snapshotUpTo: number | null;
}

/**
 * Copy `sessionId` from `from` to `to`. Order matters: the snapshot is written
 * first (which seeds the destination's high-water mark, spec §3.4), so the
 * journal tail — which starts at `snapshotUpTo + 1` after a truncated source —
 * satisfies the destination's seq-density check.
 */
export async function migrateSession(
  from: StateStore,
  to: StateStore,
  sessionId: string,
  holderId = "migrator",
): Promise<MigrateResult> {
  const lease = await acquireLease(to, sessionId, holderId);
  if (!lease.ok) {
    throw new Error(
      `migrateSession: could not acquire lease on destination for '${sessionId}' (contended, current ${lease.current})`,
    );
  }
  const fence = lease.fence;

  const snap = await from.readLatestSnapshot(sessionId);
  if (snap) await to.writeSnapshot(sessionId, snap.upToSeq, snap.bytes);

  const fromSeq = snap ? snap.upToSeq + 1 : 0;
  const tail = await from.readJournal(sessionId, fromSeq);
  for (const row of tail) {
    const r = await to.append(sessionId, row.seq, [row.bytes], fence);
    if (!r.ok) {
      throw new Error(
        `migrateSession: destination append failed at seq ${row.seq} (${r.reason})`,
      );
    }
  }
  return { records: tail.length, snapshotUpTo: snap ? snap.upToSeq : null };
}
