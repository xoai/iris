// Deterministic child-session identity (P2-9, spec §4.1). A delegation derives the child
// agent's sessionId from the PARENT session + the delegating call's id, so a recovery
// re-perform (engine danglingIntent) re-finds the SAME child session and returns its
// already-final output — making delegation idempotent under crash recovery. Pure; no I/O.

// The delimiter that separates a parent sessionId from a delegating callId. `::` cannot
// collide with a channel-minted sessionId (those are UUIDs), and every store keys sessions
// by opaque string (sqlite TEXT, fs path segment, memory Map key, store-do `_wake/` key),
// so no sanitization is needed.
const SUBAGENT_DELIMITER = "::sub::";

/**
 * Derive the deterministic child sessionId for a delegation. Given the same
 * `parentSessionId` and `callId` (the journaled, replay-stable ToolCall.callId) it always
 * returns the same id — the property recovery idempotency relies on.
 */
export function childSessionId(parentSessionId: string, callId: string): string {
  if (parentSessionId === "") {
    throw new Error("childSessionId: parentSessionId must be non-empty");
  }
  if (callId === "") {
    throw new Error("childSessionId: callId must be non-empty");
  }
  return `${parentSessionId}${SUBAGENT_DELIMITER}${callId}`;
}
