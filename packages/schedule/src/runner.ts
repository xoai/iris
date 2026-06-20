// makeScheduleRunner (P2-9, spec §5.3): the host-side PUMP that drives durable timers
// locally. `tick(now)` discovers sessions whose timer/signal is due (the scheduler's
// peek API), resumes each at most once, and confirms the wakeup ONLY after a committed
// (non-aborted) turn — so an aborted resume re-fires next tick (at-least-once). It
// generalizes demo/run.ts's single-session peek→resume→confirm to all due sessions.
// Deterministic given `now`; the caller owns the wall-clock loop / logical-time advance.
import { runTurnOn } from "@irisrun/host";
import type { HostAdapter } from "@irisrun/host";
import type { Program, PerformerRegistry, LogicalClock, Json, TurnOutcome } from "@irisrun/core";

// The host-level peek/confirm surface every concrete scheduler implements (Memory/Sqlite/
// Fs/Do) — NOT part of the core Scheduler port. May be sync or async (store-do is async).
export interface Wakeup {
  sessionId: string;
  kind: "timer" | "signal";
  name?: string;
}
export interface WakeupSource {
  dueWakeups(now: number): Wakeup[] | Promise<Wakeup[]>;
  confirmWoken(sessionId: string, now: number): void | Promise<void>;
}

// Per-(session, tick) resume inputs. `now` is the tick's logical time — the caller binds
// BOTH the engine clock AND the `clock` performer to it (see spec §5.3), so each resumed
// cycle's clock effect reads `now`. Returns null to SKIP a session this runner doesn't own.
export type ResumeInputs = (
  sessionId: string,
  now: number,
) => { defDigest: string; program: Program<Json>; performers: PerformerRegistry; clock: LogicalClock } | null;

export interface ScheduleRunnerDeps {
  host: HostAdapter;
  source: WakeupSource;
  resumeInputs: ResumeInputs;
  onWarn?: (message: string) => void;
}

export interface TickResult {
  fired: { sessionId: string; status: TurnOutcome<Json>["status"] }[];
  skipped: string[]; // due sessions with no resumeInputs — left unconfirmed for their owner
}

export interface ScheduleRunner {
  tick(now: number): Promise<TickResult>;
}

export function makeScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  return {
    async tick(now: number): Promise<TickResult> {
      const due = await deps.source.dueWakeups(now);
      const seen = new Set<string>(); // order-preserving first-wins dedupe (a session may
      // have both a due timer AND a signal — resume once)
      const fired: TickResult["fired"] = [];
      const skipped: string[] = [];

      for (const wakeup of due) {
        if (seen.has(wakeup.sessionId)) continue;
        seen.add(wakeup.sessionId);

        const inputs = deps.resumeInputs(wakeup.sessionId, now);
        if (inputs === null) {
          skipped.push(wakeup.sessionId);
          continue;
        }

        const outcome = await runTurnOn<Json>(deps.host, { sessionId: wakeup.sessionId, ...inputs });
        // Confirm ONLY when the resumed turn actually advanced the parked session — i.e.
        // it committed a marker (`finished` or `parked`). A `contended` turn never acquired
        // the lease (no turn ran, nothing journaled) and an `aborted` turn lost the lease
        // mid-flight; in BOTH the timer-park is unchanged, so leave the wakeup to re-fire on
        // a later tick (at-least-once). Consuming it on contended/aborted would orphan the
        // session if this pump was not the writer that resumed it.
        if (outcome.status === "finished" || outcome.status === "parked") {
          await deps.source.confirmWoken(wakeup.sessionId, now);
        } else if (deps.onWarn) {
          deps.onWarn(`schedule: resume of '${wakeup.sessionId}' did not commit (${outcome.status}); wakeup left to re-fire`);
        }
        fired.push({ sessionId: wakeup.sessionId, status: outcome.status });
      }

      return { fired, skipped };
    },
  };
}
