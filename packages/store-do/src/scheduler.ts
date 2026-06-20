// DoScheduler — a Scheduler over a Cloudflare Durable Object's
// storage + alarm, under the edge cold-per-isolate model: no held process. A
// timer/signal is a record under `_wake/`; the durable wakeup is the DO ALARM
// (storage.setAlarm). Mirrors FsScheduler's conformance: dueWakeups PEEKS
// (at-least-once), confirmWoken consumes ONLY after the resumed turn commits —
// the PEEK-then-confirm split makes delivery at-least-once by design (a wakeup
// re-appears until confirmed, so a turn that aborts pre-commit does not LOSE it).
// State lives in DoStorage, so a FRESH isolate over the same storage sees prior
// timers/signals (the cold-start invariant). Scheduler state is NOT migrated —
// host B uses a fresh DoScheduler; resume is signal/timer-driven from the journal.
// No @cloudflare/* import (it is written to DoStorage).
import type { DoStorage } from "./do-storage.ts";

export interface Wakeup {
  sessionId: string;
  kind: "timer" | "signal";
  name?: string;
}

interface TimerRec {
  sessionId: string;
  wakeAt: number;
  fired: boolean;
}
interface SignalRec {
  sessionId: string;
  name: string;
  payloadB64?: string;
  delivered: boolean;
}

const TIMERS = "_wake/timers/";
const SIGNALS = "_wake/signals/";
const ORD_WIDTH = 9;
const TE = new TextEncoder();
const TD = new TextDecoder();

let instanceCounter = 0;

function encodeRec(rec: unknown): Uint8Array {
  return TE.encode(JSON.stringify(rec));
}
function decodeRec<T>(bytes: Uint8Array): T {
  return JSON.parse(TD.decode(bytes)) as T;
}
// Web-standard base64 (btoa is a global on Node 24 AND the edge isolate) — no Node
// `Buffer`, so the edge adapter needs no `nodejs_compat` flag (the portability claim).
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export class DoScheduler {
  private readonly storage: DoStorage;
  constructor(storage: DoStorage) {
    this.storage = storage;
  }

  // A globally insertion-ordered key: the count of existing entries (a stable
  // ordinal across cold isolates, so dueWakeups can sort by key to mirror the
  // reference's ORDER BY rowid) + a unique suffix (so two writes in one isolate
  // never collide). Mirrors FsScheduler.nextName.
  private async nextKey(prefix: string): Promise<string> {
    const existing = await this.storage.list({ prefix });
    const n = existing.size;
    return `${prefix}${String(n).padStart(ORD_WIDTH, "0")}-${instanceCounter++}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    const rec: TimerRec = { sessionId, wakeAt, fired: false };
    await this.storage.put(await this.nextKey(TIMERS), encodeRec(rec));
    // Arm the DO alarm at the EARLIEST due time across all parked sessions in this
    // DO. NOTE: the alarm is a BEST-EFFORT wakeup HINT, not the source of truth —
    // the durable timer RECORDS above + `dueWakeups` are authoritative. The
    // getAlarm→setAlarm read-min-write is intentionally NOT transactional: real
    // Cloudflare `DurableObjectTransaction` does not expose setAlarm (it lives on
    // `storage`, not the txn). So two CONCURRENT same-isolate parks could race and
    // leave the alarm later than the earliest pending timer — but a single turn
    // parks exactly once, and even a stale/late alarm only DELAYS a self-wake; it
    // never loses a wakeup (dueWakeups still returns the due timer). Sequential
    // parks (the real path) arm monotone-down correctly.
    const existing = await this.storage.getAlarm();
    const next = existing === null ? wakeAt : Math.min(existing, wakeAt);
    if (existing === null || next !== existing) await this.storage.setAlarm(next);
  }

  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is durably recorded in the journal (a wait marker). Delivery is via
    // signal()/dueWakeups; nothing extra to persist here (reference parity).
  }

  async signal(sessionId: string, name: string, payload?: Uint8Array): Promise<void> {
    const rec: SignalRec = {
      sessionId,
      name,
      delivered: false,
      ...(payload ? { payloadB64: toB64(payload) } : {}),
    };
    await this.storage.put(await this.nextKey(SIGNALS), encodeRec(rec));
  }

  /** PEEK due timers/signals at logical time `now` (no consume). */
  async dueWakeups(now: number): Promise<Wakeup[]> {
    const out: Wakeup[] = [];
    for (const [, bytes] of await this.storage.list({ prefix: TIMERS })) {
      const rec = decodeRec<TimerRec>(bytes);
      if (!rec.fired && rec.wakeAt <= now) out.push({ sessionId: rec.sessionId, kind: "timer" });
    }
    for (const [, bytes] of await this.storage.list({ prefix: SIGNALS })) {
      const rec = decodeRec<SignalRec>(bytes);
      if (!rec.delivered) out.push({ sessionId: rec.sessionId, kind: "signal", name: rec.name });
    }
    return out;
  }

  /** Consume the wakeups for a session AFTER its resumed turn has committed. */
  async confirmWoken(sessionId: string, now: number): Promise<void> {
    for (const [key, bytes] of await this.storage.list({ prefix: TIMERS })) {
      const rec = decodeRec<TimerRec>(bytes);
      if (rec.sessionId === sessionId && !rec.fired && rec.wakeAt <= now) {
        await this.storage.put(key, encodeRec({ ...rec, fired: true }));
      }
    }
    for (const [key, bytes] of await this.storage.list({ prefix: SIGNALS })) {
      const rec = decodeRec<SignalRec>(bytes);
      if (rec.sessionId === sessionId && !rec.delivered) {
        await this.storage.put(key, encodeRec({ ...rec, delivered: true }));
      }
    }
  }
}
