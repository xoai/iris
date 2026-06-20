// Scheduler over node:sqlite. The journal records THAT a session is waiting;
// this persists the durable timer/signal so a restarted process can find and
// re-arm it (spec §3.8, §4.3). Host-side `dueWakeups` lets the runner discover
// which sessions to re-enter at a given logical time.
import type { DatabaseSync } from "node:sqlite";
import type { Scheduler } from "@irisrun/core";

export interface Wakeup {
  sessionId: string;
  kind: "timer" | "signal";
  name?: string;
}

export class SqliteScheduler implements Scheduler {
  private db: DatabaseSync;
  private timerInsert;
  private signalInsert;
  private dueTimersStmt;
  private readySignalsStmt;
  private confirmTimersStmt;
  private confirmSignalsStmt;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.timerInsert = db.prepare(
      "INSERT INTO timers (session_id, wake_at, fired) VALUES (?, ?, 0)",
    );
    this.signalInsert = db.prepare(
      "INSERT INTO signals (session_id, name, payload, delivered) VALUES (?, ?, ?, 0)",
    );
    this.dueTimersStmt = db.prepare(
      "SELECT session_id FROM timers WHERE fired = 0 AND wake_at <= ? ORDER BY wake_at ASC",
    );
    this.readySignalsStmt = db.prepare(
      "SELECT session_id, name FROM signals WHERE delivered = 0 ORDER BY rowid ASC",
    );
    this.confirmTimersStmt = db.prepare(
      "UPDATE timers SET fired = 1 WHERE session_id = ? AND fired = 0 AND wake_at <= ?",
    );
    this.confirmSignalsStmt = db.prepare(
      "UPDATE signals SET delivered = 1 WHERE session_id = ? AND delivered = 0",
    );
  }

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    this.timerInsert.run(sessionId, wakeAt);
  }

  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is durably recorded in the journal (a wait marker). Signal
    // delivery is via signal()/dueWakeups; nothing extra to persist here.
  }

  async signal(
    sessionId: string,
    name: string,
    payload?: Uint8Array,
  ): Promise<void> {
    this.signalInsert.run(sessionId, name, payload ?? null);
  }

  /**
   * Host-side: PEEK the sessions whose timer is due at logical time `now`, plus
   * any undelivered signals. Does NOT consume them — the runner must call
   * `confirmWoken` only AFTER the resumed turn commits, so a wakeup is
   * at-least-once (an aborted/crashed resume re-fires rather than orphaning the
   * session). The fenced single-writer lease prevents a double resume.
   */
  dueWakeups(now: number): Wakeup[] {
    const out: Wakeup[] = [];
    for (const t of this.dueTimersStmt.all(now) as Array<{
      session_id: string;
    }>) {
      out.push({ sessionId: t.session_id, kind: "timer" });
    }
    for (const s of this.readySignalsStmt.all() as Array<{
      session_id: string;
      name: string;
    }>) {
      out.push({ sessionId: s.session_id, kind: "signal", name: s.name });
    }
    return out;
  }

  /** Consume the wakeups for a session AFTER its resumed turn has committed. */
  confirmWoken(sessionId: string, now: number): void {
    this.confirmTimersStmt.run(sessionId, now);
    this.confirmSignalsStmt.run(sessionId);
  }
}
