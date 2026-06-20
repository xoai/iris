// FakeDoStorage — the in-suite stand-in for Cloudflare's DurableObjectState
// .storage. An in-memory Map<string,Uint8Array> with:
//   • get/put/delete/list({prefix}) (list returns sorted keys, mirroring the
//     journal-order read the DoStateStore relies on),
//   • a REAL serialized transaction(): a promise-chain mutex so two concurrent
//     transaction() callbacks NEVER interleave (the DO single-instance guarantee
//     that makes compare-and-write a true atomic CAS — no check→await→mutate gap),
//   • a settable alarm clock (setAlarm/getAlarm store a number) plus now()/
//     advanceTo() logical-time helpers so a test can drive the resume-past-alarm
//     path without wall-clock time.
// EVERYTHING in workstream A tests against this. It imports NO @cloudflare/* — it
// only realizes the DoStorage shape.
import type { DoStorage } from "@irisrun/store-do";

export class FakeDoStorage implements DoStorage {
  private readonly kv = new Map<string, Uint8Array>();
  private alarm: number | null = null;
  private clock = 0;
  // The serialization tail: each transaction() chains its callback onto this
  // promise so callbacks run strictly one-at-a-time (the single-writer mutex).
  private tail: Promise<unknown> = Promise.resolve();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.kv.get(key);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.kv.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(key);
  }

  async list(opts?: { prefix?: string }): Promise<Map<string, Uint8Array>> {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.kv.keys()].filter((k) => k.startsWith(prefix)).sort();
    const out = new Map<string, Uint8Array>();
    for (const k of keys) out.set(k, this.kv.get(k)!);
    return out;
  }

  // Serialized read-modify-write. The callback gets `this` (all access goes
  // through the live Map) but the promise-chain mutex guarantees the WHOLE
  // callback runs to completion — across its internal awaits — before the next
  // transaction's callback starts. So two concurrent transactions that both
  // read-then-write the same key cannot interleave; the second sees the first's
  // committed write. The mutex is released even if the callback throws.
  async transaction<T>(fn: (txn: DoStorage) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this));
    // Keep the chain alive even on rejection so a thrown txn does not wedge the
    // mutex; swallow the rejection on the tail (the caller still sees it via `run`).
    this.tail = run.catch(() => undefined);
    return run;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  // --- test-only logical clock (NOT part of DoStorage) ----------------------

  /** The current logical time (the isolate's "now" for dueWakeups). */
  now(): number {
    return this.clock;
  }

  /** Advance logical time to `t` (e.g. past a set alarm to drive the resume). */
  advanceTo(t: number): void {
    this.clock = t;
  }

  /** Clear the alarm (the DO alarm handler does this after a fire). */
  async clearAlarm(): Promise<void> {
    this.alarm = null;
  }
}
