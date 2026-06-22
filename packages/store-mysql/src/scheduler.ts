// MysqlScheduler — durable timers + signals over MySQL, plus the host-side WakeupSource
// (dueWakeups peeks; confirmWoken consumes after a committed turn). Rows live in
// `iris_wakeup`, so a fresh process/connection sees prior wakeups (durable). Mirrors the
// Postgres scheduler. `fired` is TINYINT(1) — 0/1 literals stand in for false/true.
import type { Scheduler } from "@irisrun/core";
import type { Wakeup, WakeupSource } from "@irisrun/schedule";
import { type MysqlPool, rowsOf } from "./mysql.ts";

export class MysqlScheduler implements Scheduler, WakeupSource {
  private readonly pool: MysqlPool; // explicit field — strip-only TS mode forbids param properties
  constructor(pool: MysqlPool) {
    this.pool = pool;
  }

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    await this.pool.query("INSERT INTO iris_wakeup (session, kind, wake_at) VALUES (?, 'timer', ?)", [sessionId, wakeAt]);
  }

  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is recorded in the journal; delivery is via signal()/dueWakeups.
  }

  async signal(sessionId: string, name: string, _payload?: Uint8Array): Promise<void> {
    await this.pool.query("INSERT INTO iris_wakeup (session, kind, name) VALUES (?, 'signal', ?)", [sessionId, name]);
  }

  /** PEEK due timers/signals at logical time `now` (no consume); DISTINCT by (session,kind,name). */
  async dueWakeups(now: number): Promise<Wakeup[]> {
    const rows = rowsOf(
      await this.pool.query(
        "SELECT DISTINCT session, kind, name FROM iris_wakeup WHERE fired=0 AND (kind='signal' OR wake_at<=?) ORDER BY session, kind, name",
        [now],
      ),
    );
    return rows.map((row) => {
      const sessionId = row.session as string;
      const kind = row.kind as "timer" | "signal";
      return kind === "signal" ? { sessionId, kind, name: row.name as string } : { sessionId, kind };
    });
  }

  /** Consume a session's due wakeups AFTER its resumed turn has committed. */
  async confirmWoken(sessionId: string, now: number): Promise<void> {
    await this.pool.query(
      "UPDATE iris_wakeup SET fired=1 WHERE session=? AND fired=0 AND (kind='signal' OR wake_at<=?)",
      [sessionId, now],
    );
  }
}
