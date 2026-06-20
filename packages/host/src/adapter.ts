// HostAdapter: a host is just {name, capabilities, store, scheduler}.
// `runTurnOn` runs a turn ON a host's store+scheduler — the host convenience that
// makes "the SAME image, a DIFFERENT host" explicit. It REPLACES the framework's
// enterTurn(sessionId,event) member (there is nothing to replace — no core type);
// it is a thin call into the engine's runTurn with the adapter's ports injected.
// `checkHostCapabilities` is the tool/host-level capability refusal (the FULL host
// capability-diff gate stays deferred). Host-side; core stays pure.
import { runTurn } from "@irisrun/core";
import type {
  StateStore,
  Scheduler,
  LogicalClock,
  Program,
  PerformerRegistry,
  TurnOutcome,
  JournalRecord,
  Json,
} from "@irisrun/core";
import type { CapabilityProfile } from "@irisrun/agent";

export interface HostAdapter {
  name: string;
  capabilities: CapabilityProfile;
  store: StateStore;
  scheduler: Scheduler;
}

export interface RunTurnOnOptions<S extends Json> {
  sessionId: string;
  defDigest: string;
  program: Program<S>;
  performers: PerformerRegistry;
  clock: LogicalClock;
  holderId?: string; // defaults to the host name (a stable per-host writer identity)
  assertReplay?: boolean;
  snapshotThreshold?: number;
  keepHistory?: boolean;
  maxStepsPerTurn?: number;
  onWarn?: (message: string) => void;
  // Per-REQUEST read-only observer of committed journal records (forwarded to the
  // engine). Threaded here, NOT via TurnInputs — TurnInputs is per-session-static
  // while onRecord binds to one response stream. Streaming channels set it per turn.
  onRecord?: (record: JournalRecord) => void;
}

/** Run one turn on `adapter`'s store + scheduler. Same image (defDigest) + program
 *  on any host → the engine's deterministic replay does the rest. */
export async function runTurnOn<S extends Json>(
  adapter: HostAdapter,
  opts: RunTurnOnOptions<S>,
): Promise<TurnOutcome<S>> {
  return runTurn<S>(
    {
      store: adapter.store,
      scheduler: adapter.scheduler,
      clock: opts.clock,
      program: opts.program,
      performers: opts.performers,
      defDigest: opts.defDigest,
      holderId: opts.holderId ?? adapter.name,
      assertReplay: opts.assertReplay,
      snapshotThreshold: opts.snapshotThreshold,
      keepHistory: opts.keepHistory,
      maxStepsPerTurn: opts.maxStepsPerTurn,
      onWarn: opts.onWarn,
      onRecord: opts.onRecord,
    },
    opts.sessionId,
  );
}

// The boolean capability keys (tool_locality is a profile STRING, not a gateable
// boolean, so it is not part of this refusal — the full degrade/refuse matrix is deferred).
const BOOLEAN_CAPS = [
  "long_running",
  "local_subprocess",
  "filesystem",
  "websockets",
] as const;

/**
 * Tool/host-level capability check: for every capability the image
 * REQUIRES (`requires[k] === true`), the host must PROVIDE it (`capabilities[k]
 * === true`). `undefined`/`false` on the host means NOT satisfied — never silently
 * widened (cf. the secure-floor posture). Refuses LOUDLY, naming the gaps; the
 * full host capability-diff gate is deferred.
 */
export function checkHostCapabilities(
  requires: CapabilityProfile,
  capabilities: CapabilityProfile,
  hostName = "host",
): void {
  const unmet: string[] = [];
  for (const k of BOOLEAN_CAPS) {
    if (requires[k] === true && capabilities[k] !== true) {
      unmet.push(`${k} (required true, host has ${JSON.stringify(capabilities[k])})`);
    }
  }
  if (unmet.length > 0) {
    throw new Error(
      `checkHostCapabilities: '${hostName}' cannot satisfy required capabilities: ${unmet.join("; ")}`,
    );
  }
}
