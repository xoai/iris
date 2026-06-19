// In-memory Scheduler mirroring SqliteScheduler semantics: dueWakeups peeks,
// confirmWoken consumes (at-least-once wakeup).
import type { Scheduler } from "@iris/core";

export interface Wakeup {
  sessionId: string;
  kind: "timer" | "signal";
  name?: string;
}

export class MemoryScheduler implements Scheduler {
  private timers: Array<{ sessionId: string; wakeAt: number; fired: boolean }> = [];
  private signals: Array<{
    sessionId: string;
    name: string;
    payload?: Uint8Array;
    delivered: boolean;
  }> = [];

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    this.timers.push({ sessionId, wakeAt, fired: false });
  }
  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // wait is recorded in the journal; delivery is via signal()/dueWakeups
  }
  async signal(
    sessionId: string,
    name: string,
    payload?: Uint8Array,
  ): Promise<void> {
    this.signals.push({ sessionId, name, payload, delivered: false });
  }

  /** PEEK due timers/signals at logical time `now` (no consume). */
  dueWakeups(now: number): Wakeup[] {
    const out: Wakeup[] = [];
    for (const t of this.timers) {
      if (!t.fired && t.wakeAt <= now) {
        out.push({ sessionId: t.sessionId, kind: "timer" });
      }
    }
    for (const s of this.signals) {
      if (!s.delivered) {
        out.push({ sessionId: s.sessionId, kind: "signal", name: s.name });
      }
    }
    return out;
  }

  /** Consume the wakeups for a session AFTER its resumed turn has committed. */
  confirmWoken(sessionId: string, now: number): void {
    for (const t of this.timers) {
      if (t.sessionId === sessionId && !t.fired && t.wakeAt <= now) t.fired = true;
    }
    for (const s of this.signals) {
      if (s.sessionId === sessionId && !s.delivered) s.delivered = true;
    }
  }
}
