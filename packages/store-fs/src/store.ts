// FsStateStore — a StateStore over node:fs under the SERVERLESS cold-per-turn
// model (spec §3.2): the store holds NO long-lived handle. Every method opens,
// reads/writes, and returns, so a FRESH instance over the same root behaves
// identically to a reused one (the serverless invariant, T2). It enforces the
// SAME invariants as the sqlite/memory stores — true CAS, fenced+dense append,
// an hwm that survives truncation, writeSnapshot-seeds-hwm — using ATOMIC fs
// primitives (O_EXCL create) so each op's decision point is atomic. Correctness
// rests on FENCING, not acquire-time locking (ADR/lease.ts). Node-only, so it
// lives in a host adapter, never in core (boundary A1).
import { open, mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import type {
  StateStore,
  CasResult,
  AppendResult,
  JournalRow,
  Version,
} from "@irisrun/core";

export interface FsStoreOptions {
  root: string;
}

// Percent-encode every byte that is not unreserved-and-path-safe. This turns a
// sessionId/key (e.g. the lease key "lease:<sid>" with ':' and '/') into ONE
// filename segment that can never become a path separator — so a key cannot
// traverse out of its subtree. `.` is encoded too, so a "../x" key collapses to
// a literal segment rather than a parent reference.
function encodeSegment(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    // A-Z a-z 0-9 - _  → safe; everything else (incl. / \ : . space) → %XX
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f
    ) {
      out += String.fromCharCode(b);
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path);
    return new Uint8Array(buf);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

let tmpCounter = 0;

export class FsStateStore implements StateStore {
  private readonly root: string;

  constructor(opts: FsStoreOptions) {
    this.root = resolve(opts.root);
  }

  // Resolve a path from root-relative segments and REFUSE (loudly) any result
  // that escapes the root — defense-in-depth behind encodeSegment.
  private under(...segments: string[]): string {
    const full = resolve(this.root, ...segments);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(
        `FsStateStore: refusing a path that escapes the store root (${full} ⊄ ${this.root})`,
      );
    }
    return full;
  }

  private journalDir(sessionId: string): string {
    return this.under(encodeSegment(sessionId), "journal");
  }
  private snapshotsDir(sessionId: string): string {
    return this.under(encodeSegment(sessionId), "snapshots");
  }
  private kvDir(key: string): string {
    return this.under("kv", encodeSegment(key));
  }
  private fenceFile(sessionId: string): string {
    return this.under(encodeSegment(sessionId), "fence");
  }

  // --- kv / CAS -------------------------------------------------------------
  // A value is a version chain kv/<encKey>/<version>.json; the current version is
  // the highest file present. CAS = O_EXCL create of <expected+1>.json — the
  // atomic decision point (create-if-not-exists is atomic on the fs). This is a
  // TRUE atomic CAS (no read-modify-write window), which acquireLease rides.

  private async maxVersion(key: string): Promise<Version | null> {
    const names = await readDirNames(this.kvDir(key));
    let max: number | null = null;
    for (const n of names) {
      const m = /^(\d+)\.json$/.exec(n);
      if (m) {
        const v = Number(m[1]);
        if (max === null || v > max) max = v;
      }
    }
    return max;
  }

  async load(
    key: string,
  ): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const version = await this.maxVersion(key);
    if (version === null) return null;
    const bytes = await readBytes(join(this.kvDir(key), `${version}.json`));
    if (bytes === null) return null;
    return { bytes, version };
  }

  async cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult> {
    const current = await this.maxVersion(key); // null ⇔ no version yet
    if (current !== expected) return { ok: false, current: current ?? 0 };
    const version = (current ?? 0) + 1;
    const dir = this.kvDir(key);
    await mkdir(dir, { recursive: true });
    try {
      const fh = await open(join(dir, `${version}.json`), "wx"); // O_EXCL
      try {
        await fh.writeFile(next);
      } finally {
        await fh.close();
      }
      return { ok: true, version };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        // lost the create race — report the now-current version
        const now = await this.maxVersion(key);
        return { ok: false, current: now ?? version };
      }
      throw e;
    }
  }

  // --- fence (highest fence that has appended; mirrors journal_fence) --------

  private async readFence(sessionId: string): Promise<Version> {
    const bytes = await readBytes(this.fenceFile(sessionId));
    if (bytes === null) return 0;
    const n = Number(new TextDecoder().decode(bytes));
    return Number.isFinite(n) ? n : 0;
  }

  private async raiseFence(sessionId: string, fence: Version): Promise<void> {
    const cur = await this.readFence(sessionId);
    const next = Math.max(cur, fence);
    if (next === cur && cur !== 0) return; // no lowering, no needless write
    await this.atomicWrite(this.fenceFile(sessionId), new TextEncoder().encode(String(next)));
  }

  // --- hwm: DERIVED from the dir (no mutable sentinel → no read-modify-write
  // race). hwm = max(snapshot.upToSeq, the gap-free journal prefix above it).

  private async snapshotUpTo(sessionId: string): Promise<number> {
    const names = await readDirNames(this.snapshotsDir(sessionId));
    let max = -1;
    for (const n of names) {
      const m = /^(\d+)$/.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  private async journalSeqs(sessionId: string): Promise<Set<number>> {
    const names = await readDirNames(this.journalDir(sessionId));
    const seqs = new Set<number>();
    for (const n of names) {
      const m = /^(\d+)\.json$/.exec(n);
      if (m) seqs.add(Number(m[1]));
    }
    return seqs;
  }

  private async hwm(sessionId: string): Promise<number> {
    const base = await this.snapshotUpTo(sessionId); // -1 if none
    const seqs = await this.journalSeqs(sessionId);
    let s = base;
    while (seqs.has(s + 1)) s += 1; // walk the gap-free prefix above the snapshot
    return s;
  }

  // --- append: fenced + dense via O_EXCL ------------------------------------

  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    const storedFence = await this.readFence(sessionId);
    if (fence < storedFence) {
      return { ok: false, reason: "stale_fence", currentFence: storedFence };
    }
    const last = await this.hwm(sessionId);
    if (last !== expectedSeq - 1) {
      return { ok: false, reason: "seq_conflict", currentSeq: last };
    }

    const dir = this.journalDir(sessionId);
    await mkdir(dir, { recursive: true });

    // All-or-nothing: O_EXCL-create each record file in seq order; if any seq is
    // already taken (a racing writer won it), roll back the ones written THIS
    // batch and report seq_conflict. The engine appends one record per commit, so
    // the multi-record path is conformance-only; rollback keeps it atomic.
    const written: string[] = [];
    let seq = last;
    try {
      for (const bytes of records) {
        seq += 1;
        const path = join(dir, `${seq}.json`);
        const fh = await open(path, "wx"); // O_EXCL — the atomic dense check
        try {
          await fh.writeFile(bytes);
        } finally {
          await fh.close();
        }
        written.push(path);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        for (const p of written) await unlink(p).catch(() => {});
        return { ok: false, reason: "seq_conflict", currentSeq: await this.hwm(sessionId) };
      }
      for (const p of written) await unlink(p).catch(() => {});
      throw e;
    }

    await this.raiseFence(sessionId, fence);
    return { ok: true, seq };
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const seqs = [...(await this.journalSeqs(sessionId))]
      .filter((s) => s >= fromSeq)
      .sort((a, b) => a - b);
    const dir = this.journalDir(sessionId);
    const rows: JournalRow[] = [];
    for (const seq of seqs) {
      const bytes = await readBytes(join(dir, `${seq}.json`));
      if (bytes !== null) rows.push({ seq, bytes });
    }
    return rows;
  }

  // --- snapshots ------------------------------------------------------------
  // writeSnapshot SEEDS the hwm to max(hwm, upToSeq) implicitly: hwm derives
  // from snapshotUpTo, so writing snapshots/<upToSeq> raises it (spec §3.2).

  async writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const dir = this.snapshotsDir(sessionId);
    await mkdir(dir, { recursive: true });
    await this.atomicWrite(join(dir, String(upToSeq)), bytes);
  }

  async readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const upToSeq = await this.snapshotUpTo(sessionId);
    if (upToSeq < 0) return null;
    const bytes = await readBytes(join(this.snapshotsDir(sessionId), String(upToSeq)));
    if (bytes === null) return null;
    return { upToSeq, bytes };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    const dir = this.journalDir(sessionId);
    for (const seq of await this.journalSeqs(sessionId)) {
      if (seq <= throughSeq) await unlink(join(dir, `${seq}.json`)).catch(() => {});
    }
  }

  // Atomic overwrite via a temp file + rename (rename is atomic on the fs).
  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  // --- test helper: simulate another writer winning a seq out-of-band -------
  // Mirrors MemStateStore.forceAppendRaw — used by the all-or-nothing batch test
  // to occupy a seq the batch will then collide with.
  async forceAppendRaw(
    sessionId: string,
    seq: number,
    bytes: Uint8Array,
    fence: Version,
  ): Promise<number> {
    const dir = this.journalDir(sessionId);
    await mkdir(dir, { recursive: true });
    await this.atomicWrite(join(dir, `${seq}.json`), bytes);
    await this.raiseFence(sessionId, fence);
    return seq;
  }
}
