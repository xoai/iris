// PostgresScheduler — durable timers + signals over PostgreSQL, plus the host-side
// WakeupSource (dueWakeups peeks; confirmWoken consumes after a committed turn). Rows
// live in `iris_wakeup`, so a fresh process/connection sees prior wakeups (durable).
import type { Scheduler } from "@irisrun/core";
import type { Wakeup, WakeupSource } from "@irisrun/schedule";
import type { PgPool } from "./pg.ts";

export class PostgresScheduler implements Scheduler, WakeupSource {
  constructor(private readonly pool: PgPool) {}

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    await this.pool.query("INSERT INTO iris_wakeup (session, kind, wake_at) VALUES ($1, 'timer', $2)", [sessionId, wakeAt]);
  }

  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is recorded in the journal; delivery is via signal()/dueWakeups.
  }

  async signal(sessionId: string, name: string, _payload?: Uint8Array): Promise<void> {
    await this.pool.query("INSERT INTO iris_wakeup (session, kind, name) VALUES ($1, 'signal', $2)", [sessionId, name]);
  }

  /** PEEK due timers/signals at logical time `now` (no consume). */
  async dueWakeups(now: number): Promise<Wakeup[]> {
    const r = await this.pool.query(
      "SELECT DISTINCT session, kind, name FROM iris_wakeup WHERE fired=false AND (kind='signal' OR wake_at<=$1) ORDER BY session, kind, name",
      [now],
    );
    return r.rows.map((row) => {
      const sessionId = row.session as string;
      const kind = row.kind as "timer" | "signal";
      return kind === "signal" ? { sessionId, kind, name: row.name as string } : { sessionId, kind };
    });
  }

  /** Consume a session's due wakeups AFTER its resumed turn has committed. */
  async confirmWoken(sessionId: string, now: number): Promise<void> {
    await this.pool.query(
      "UPDATE iris_wakeup SET fired=true WHERE session=$1 AND fired=false AND (kind='signal' OR wake_at<=$2)",
      [sessionId, now],
    );
  }
}
