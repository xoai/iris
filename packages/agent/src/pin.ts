// Session pinning + definition migration — ZERO engine
// change. A session pins the image digest as its governing `defDigest` (the engine
// already stamps every record). Pinning/migration ride the EXISTING per-record
// defDigest + the `upgraded` marker; this module uses only the StateStore port +
// journal types + the lease. Host-side.
import { acquireLease, releaseLease, encode, decode } from "@irisrun/core";
import type { StateStore, JournalRecord, Json } from "@irisrun/core";

/**
 * The latest journal record, read SNAPSHOT-SAFELY. After a snapshot the journal
 * holds only `seq > snapshotSeq`; the terminal `wait`/`finish` marker is committed
 * after the snapshot seq (the engine snapshots only in the effect branch), so it
 * always survives `truncateJournal`. Mirrors the engine's recovery read offset.
 * Returns null for a never-started session (empty journal + no snapshot).
 */
export async function latestRecord(
  store: StateStore,
  sessionId: string,
): Promise<JournalRecord | null> {
  const snap = await store.readLatestSnapshot(sessionId);
  const tail = await store.readJournal(sessionId, (snap?.upToSeq ?? -1) + 1);
  const row = tail.at(-1);
  return row ? (decode(row.bytes) as unknown as JournalRecord) : null;
}

/**
 * The governing image digest a session is pinned to = the `defDigest` of its
 * latest journal record. `null` ⇒ a never-started session → the caller adopts the
 * run layout's imageDigest as the birth pin. A LIVE session re-runs under its own
 * governing digest, so a redeploy (a new image digest) does not change its pin.
 */
export async function governingDigest(
  store: StateStore,
  sessionId: string,
): Promise<string | null> {
  const last = await latestRecord(store, sessionId);
  return last ? last.defDigest : null;
}

export interface MigrateOptions {
  from: string;
  to: string;
  holderId?: string;
  now?: number;
}

// Markers that mark a turn boundary (the engine emits these; `turn_started` is
// intentionally NOT used — the engine never emits it).
const TURN_TERMINAL_MARKERS = new Set(["wait", "finish"]);

/**
 * Migrate a LIVE session's pinned definition `from`→`to` at a turn boundary
 * (hold-and-migrate). Appends an `upgraded {from,to,atTurn}` marker
 * stamped with `defDigest: to`; subsequent turns run with `defDigest = to`. Refuses
 * LOUDLY when the session has not started, is mid-turn, or its governing digest is
 * not `from`. `atTurn` = the boundary journal sequence (the engine emits no
 * turn-start marker to count). Reference impl: core `migrateSession` (the
 * acquireLease → snapshot-aware seq → fenced append pattern). engine.ts untouched.
 */
export async function migrateDefinition(
  store: StateStore,
  sessionId: string,
  opts: MigrateOptions,
): Promise<void> {
  const holderId = opts.holderId ?? "migrator";
  const lease = await acquireLease(store, sessionId, holderId);
  if (!lease.ok) {
    throw new Error(
      `migrateDefinition: could not acquire lease for '${sessionId}' (contended, current ${lease.current})`,
    );
  }
  const fence = lease.fence;
  try {
    const last = await latestRecord(store, sessionId);
    if (last === null) {
      throw new Error(`migrateDefinition: cannot migrate '${sessionId}' — it has not started (no journal)`);
    }
    const marker = last.kind === "marker" ? (last.payload as { marker?: string }).marker : undefined;
    if (last.kind !== "marker" || marker === undefined || !TURN_TERMINAL_MARKERS.has(marker)) {
      throw new Error(
        `migrateDefinition: '${sessionId}' is not at a turn boundary (latest record is ${last.kind}${marker ? `/${marker}` : ""}) — migrate only between turns`,
      );
    }
    if (last.defDigest !== opts.from) {
      throw new Error(
        `migrateDefinition: '${sessionId}' governing digest is ${last.defDigest}, not the expected from=${opts.from}`,
      );
    }
    const nextSeq = last.seq + 1;
    const record: JournalRecord = {
      seq: nextSeq,
      ts: opts.now ?? 0, // reducers MUST NOT read ts (determinism contract)
      defDigest: opts.to,
      kind: "marker",
      payload: { marker: "upgraded", from: opts.from, to: opts.to, atTurn: nextSeq },
    };
    const res = await store.append(sessionId, nextSeq, [encode(record as unknown as Json)], fence);
    if (!res.ok) {
      throw new Error(`migrateDefinition: append failed at seq ${nextSeq} (${res.reason})`);
    }
  } finally {
    await releaseLease(store, sessionId, fence);
  }
}
