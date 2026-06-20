// driveToCompletion: run a CHILD agent session to a terminal state by
// repeatedly running turns on the child's host. A child that PARKS (HITL/timer/user/signal)
// is reported as parked — NOT force-driven — because parking is a legitimate durable state
// the child chose; the caller decides what to do with the returned sessionId. Host-side
// (reuses @irisrun/host runTurnOn); the engine's replay/recovery does the determinism.
import { runTurnOn } from "@irisrun/host";
import type { HostAdapter } from "@irisrun/host";
import type {
  Program,
  PerformerRegistry,
  LogicalClock,
  Json,
  WaitSpec,
} from "@irisrun/core";

export const DEFAULT_MAX_TURNS = 64;

export interface DriveToCompletionDeps<S extends Json> {
  host: HostAdapter;
  defDigest: string;
  program: Program<S>;
  performers: PerformerRegistry;
  clock: LogicalClock;
  // Guards a child that never reaches a terminal state (e.g. a perpetually contended
  // lease). Default DEFAULT_MAX_TURNS. Must be a positive integer.
  maxTurns?: number;
  assertReplay?: boolean;
  // Optional diagnostics sink. Fired once per CONTENDED retry (the lease was held
  // elsewhere) so a long maxTurns spin-to-exhaustion is observable instead of silent.
  onWarn?: (message: string) => void;
}

// The outcome of driving a child. `finished`/`parked` are normal terminal/suspended
// states; `exhausted` means maxTurns elapsed without a terminal turn (kept contended);
// `aborted` is an infra lease/seq loss (the only outcome the parent performer maps to a
// retryable {ok:false}).
export type ChildOutcome =
  | { status: "finished"; output?: Json }
  | { status: "parked"; wait: WaitSpec }
  | { status: "exhausted"; turns: number }
  | { status: "aborted"; reason: "lease_lost" | "seq_conflict" };

/**
 * Drive `childSessionId` on `deps.host` until it finishes, parks, aborts, or hits
 * `maxTurns`. A `contended` turn (lease busy) is retried within the cap; everything else
 * is terminal for this call. A not-yet-created child is created lazily by its first
 * `runTurnOn` (engine: no snapshot + empty journal ⇒ program.initial), so a fresh
 * delegation runs from the start and a recovery re-perform replays an already-finished
 * child to the SAME output.
 */
export async function driveToCompletion<S extends Json>(
  childSessionId: string,
  deps: DriveToCompletionDeps<S>,
): Promise<ChildOutcome> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(`driveToCompletion: maxTurns must be a positive integer, got ${String(maxTurns)}`);
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    const out = await runTurnOn<S>(deps.host, {
      sessionId: childSessionId,
      defDigest: deps.defDigest,
      program: deps.program,
      performers: deps.performers,
      clock: deps.clock,
      ...(deps.assertReplay !== undefined ? { assertReplay: deps.assertReplay } : {}),
    });

    switch (out.status) {
      case "finished":
        return out.output !== undefined
          ? { status: "finished", output: out.output }
          : { status: "finished" };
      case "parked":
        return { status: "parked", wait: out.wait };
      case "aborted":
        return { status: "aborted", reason: out.reason };
      case "contended":
        // The lease was held elsewhere — nothing was journaled. Retry within the cap,
        // surfacing each contention so a spin toward `exhausted` is not silent.
        if (deps.onWarn) {
          deps.onWarn(`subagent child '${childSessionId}' contended on turn ${turn + 1}/${maxTurns} (lease held elsewhere); retrying`);
        }
        continue;
    }
  }
  return { status: "exhausted", turns: maxTurns };
}
