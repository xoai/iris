// Import a portable export into a destination StateStore (spec §4). Mirrors
// migrateSession's destination half (snapshot-first then dense fenced append),
// but STRICTER: it releases the lease on every path (migrateSession leaks it)
// and refuses a non-empty destination BEFORE any write (migrateSession can
// clobber a snapshot).
import { acquireLease, releaseLease } from "@irisrun/core";
import type { StateStore } from "@irisrun/core";
import type { JournalExportV1 } from "./types.ts";
import { fromB64 } from "./content-address.ts";

export interface ImportResult {
  records: number;
  snapshotUpTo: number | null;
}

export async function importSession(
  store: StateStore,
  x: JournalExportV1,
  holderId = "importer",
): Promise<ImportResult> {
  const lease = await acquireLease(store, x.sessionId, holderId);
  if (!lease.ok) {
    throw new Error(
      `importSession: could not acquire lease on '${x.sessionId}' (contended, current ${lease.current})`,
    );
  }
  const fence = lease.fence;
  try {
    // Refuse a non-empty destination BEFORE any write — no snapshot clobber.
    const existingSnap = await store.readLatestSnapshot(x.sessionId);
    const existingJournal = await store.readJournal(x.sessionId, 0);
    if (existingSnap !== null || existingJournal.length > 0) {
      throw new Error(`importSession: destination already has session '${x.sessionId}'`);
    }
    if (x.snapshot) {
      await store.writeSnapshot(x.sessionId, x.snapshot.upToSeq, fromB64(x.snapshot.bytesB64));
    }
    for (const r of x.records) {
      // Append the raw decoded bytes VERBATIM — never re-canonicalize.
      const res = await store.append(x.sessionId, r.seq, [fromB64(r.bytesB64)], fence);
      if (!res.ok) {
        throw new Error(`importSession: append failed at seq ${r.seq} (${res.reason})`);
      }
    }
    return { records: x.records.length, snapshotUpTo: x.snapshot ? x.snapshot.upToSeq : null };
  } finally {
    await releaseLease(store, x.sessionId, fence);
  }
}
