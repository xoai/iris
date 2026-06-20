// Deterministic fault-injection wrappers over a real StateStore, for exercising the
// `contended` / `aborted` turn outcomes (which otherwise only arise under a genuine
// concurrent-writer race). Each wrapper DELEGATES every method to the inner store except
// the one fault it injects. Used by the subagent driver tests (exhausted/aborted) and the
// schedule-pump at-least-once test (an aborted resume must NOT consume its wakeup).
import type { StateStore, CasResult, AppendResult, JournalRow, Version } from "@iris/core";

// A store whose `cas` ALWAYS fails → `acquireLease` returns {ok:false} → runTurn returns
// `{status:"contended"}` every time. (Reads/journal still delegate so replay is sane.)
export function makeContendedStore(inner: StateStore): StateStore {
  return {
    load: (key) => inner.load(key),
    cas: async (): Promise<CasResult> => ({ ok: false, current: 999 }),
    append: (sessionId, expectedSeq, records, fence) =>
      inner.append(sessionId, expectedSeq, records, fence),
    readJournal: (sessionId, fromSeq) => inner.readJournal(sessionId, fromSeq),
    writeSnapshot: (sessionId, upToSeq, bytes) => inner.writeSnapshot(sessionId, upToSeq, bytes),
    readLatestSnapshot: (sessionId) => inner.readLatestSnapshot(sessionId),
    truncateJournal: (sessionId, throughSeq) => inner.truncateJournal(sessionId, throughSeq),
  };
}

// A store that lets the lease be acquired but fails the NEXT `append` once with a
// stale_fence → the engine raises LeaseLost → runTurn returns `{status:"aborted",
// reason:"lease_lost"}`. `fired` flips after the first injected failure so a RESUMED turn
// can succeed (models a transient takeover).
export function makeAbortOnAppendStore(inner: StateStore, currentFence: Version = 7): {
  store: StateStore;
  state: { fired: boolean };
} {
  const state = { fired: false };
  const store: StateStore = {
    load: (key) => inner.load(key),
    cas: (key, expected, next) => inner.cas(key, expected, next),
    append: async (sessionId, expectedSeq, records, fence): Promise<AppendResult> => {
      if (!state.fired) {
        state.fired = true;
        return { ok: false, reason: "stale_fence", currentFence };
      }
      return inner.append(sessionId, expectedSeq, records, fence);
    },
    readJournal: (sessionId, fromSeq): Promise<JournalRow[]> => inner.readJournal(sessionId, fromSeq),
    writeSnapshot: (sessionId, upToSeq, bytes) => inner.writeSnapshot(sessionId, upToSeq, bytes),
    readLatestSnapshot: (sessionId) => inner.readLatestSnapshot(sessionId),
    truncateJournal: (sessionId, throughSeq) => inner.truncateJournal(sessionId, throughSeq),
  };
  return { store, state };
}
