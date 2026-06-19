// FsScheduler — a Scheduler (spec §3.3) over DURABLE files: no held process. A
// timer/signal is a file under <root>/_wake/; a host re-enters "acquire lease →
// replay → continue" when one fires (the serverless "enqueue a delayed
// invocation" model). Mirrors the reference schedulers' conformance: dueWakeups
// PEEKS (at-least-once), confirmWoken consumes only AFTER the resumed turn
// commits. State lives on disk, so a FRESH instance over the same root sees prior
// timers/signals (the cold-start invariant). Scheduler state is NOT migrated —
// host B uses a fresh FsScheduler; the demo's HITL resume is signal_recv-driven.
import { open, mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { resolve, sep, join } from "node:path";

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

let tmpCounter = 0;

export class FsScheduler {
  private readonly root: string;
  constructor(opts: { root: string }) {
    this.root = resolve(opts.root);
  }

  private under(...segments: string[]): string {
    const full = resolve(this.root, ...segments);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`FsScheduler: refusing a path that escapes the root (${full})`);
    }
    return full;
  }
  private timersDir(): string {
    return this.under("_wake", "timers");
  }
  private signalsDir(): string {
    return this.under("_wake", "signals");
  }

  // A globally insertion-ordered filename: the count of existing entries (a stable
  // ordinal across cold instances) + a unique suffix. So dueWakeups can sort by
  // name to mirror the reference's ORDER BY rowid.
  private async nextName(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const n = (await readDirNames(dir)).length;
    return `${String(n).padStart(9, "0")}-${process.pid}-${tmpCounter++}.json`;
  }

  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    const dir = this.timersDir();
    const rec: TimerRec = { sessionId, wakeAt, fired: false };
    await writeJson(join(dir, await this.nextName(dir)), rec);
  }

  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is durably recorded in the journal (a wait marker). Delivery is via
    // signal()/dueWakeups; nothing extra to persist here (reference parity).
  }

  async signal(sessionId: string, name: string, payload?: Uint8Array): Promise<void> {
    const dir = this.signalsDir();
    const rec: SignalRec = {
      sessionId,
      name,
      delivered: false,
      ...(payload ? { payloadB64: Buffer.from(payload).toString("base64") } : {}),
    };
    await writeJson(join(dir, await this.nextName(dir)), rec);
  }

  /** PEEK due timers/signals at logical time `now` (no consume). */
  async dueWakeups(now: number): Promise<Wakeup[]> {
    const out: Wakeup[] = [];
    for (const { rec } of await readSorted<TimerRec>(this.timersDir())) {
      if (!rec.fired && rec.wakeAt <= now) out.push({ sessionId: rec.sessionId, kind: "timer" });
    }
    for (const { rec } of await readSorted<SignalRec>(this.signalsDir())) {
      if (!rec.delivered) out.push({ sessionId: rec.sessionId, kind: "signal", name: rec.name });
    }
    return out;
  }

  /** Consume the wakeups for a session AFTER its resumed turn has committed. */
  async confirmWoken(sessionId: string, now: number): Promise<void> {
    for (const { path, rec } of await readSorted<TimerRec>(this.timersDir())) {
      if (rec.sessionId === sessionId && !rec.fired && rec.wakeAt <= now) {
        await rewriteJson(path, { ...rec, fired: true });
      }
    }
    for (const { path, rec } of await readSorted<SignalRec>(this.signalsDir())) {
      if (rec.sessionId === sessionId && !rec.delivered) {
        await rewriteJson(path, { ...rec, delivered: true });
      }
    }
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function readSorted<T>(dir: string): Promise<Array<{ path: string; rec: T }>> {
  const names = (await readDirNames(dir)).filter((n) => n.endsWith(".json")).sort();
  const out: Array<{ path: string; rec: T }> = [];
  for (const n of names) {
    const path = join(dir, n);
    const txt = await readFile(path, "utf8");
    out.push({ path, rec: JSON.parse(txt) as T });
  }
  return out;
}

async function writeJson(path: string, rec: unknown): Promise<void> {
  const fh = await open(path, "wx"); // O_EXCL — each entry created once
  try {
    await fh.writeFile(JSON.stringify(rec));
  } finally {
    await fh.close();
  }
}

async function rewriteJson(path: string, rec: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, JSON.stringify(rec));
  await rename(tmp, path); // atomic state flip (fired/delivered)
}
