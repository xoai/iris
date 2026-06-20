// DoStateStore — a StateStore over a Cloudflare Durable Object's storage (the
// narrow DoStorage abstraction), under the edge cold-per-isolate model: the
// store holds NO mutable session state, so a FRESH instance over the
// same DoStorage behaves identically to a reused one (the edge analogue of the
// serverless cold-per-turn invariant). It enforces the SAME invariants as the
// sqlite/fs stores — true CAS, fenced+dense append (stale_fence precedence over
// seq_conflict), an hwm that survives truncation, writeSnapshot-seeds-hwm — but
// rides storage.transaction() for atomicity instead of fs O_EXCL: the
// compare-and-write happens inside ONE transaction with no check→await→mutate
// gap ([[lrn-single-use-token-toctou]]), and the DO single-instance guarantee +
// txn conflict-retry give true CAS. Key encoding is prefix-confined; no key
// escapes its namespace. No @cloudflare/* import (it is written to DoStorage).
import type {
  StateStore,
  CasResult,
  AppendResult,
  JournalRow,
  Version,
} from "@irisrun/core";
import type { DoStorage } from "./do-storage.ts";

// Percent-encode every byte that is not unreserved (A-Z a-z 0-9 - _). This turns
// a sessionId/key into ONE key segment that can never carry the '/' namespace
// separator the DoStorage keys use, so a key cannot bleed into another
// namespace (the edge analogue of FsStateStore.encodeSegment's traversal guard).
function encodeSegment(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
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

// Seqs are stored as zero-padded suffixes so a lexical key list is ALSO seq
// order; but every read parses the numeric suffix and sorts numerically, so
// correctness never depends on the padding width.
const SEQ_WIDTH = 16;
const padSeq = (n: number): string => String(n).padStart(SEQ_WIDTH, "0");

const TE = new TextEncoder();
const TD = new TextDecoder();

// A KV record: the version chain collapses to ONE record holding the current
// version + value (CAS is atomic inside a transaction, so no O_EXCL chain is
// needed). Bytes are base64 so the record is JSON (DoStorage values are bytes).
interface KvRecord {
  version: Version;
  b64: string;
}

function encodeKv(rec: KvRecord): Uint8Array {
  return TE.encode(JSON.stringify(rec));
}
function decodeKv(bytes: Uint8Array): KvRecord {
  return JSON.parse(TD.decode(bytes)) as KvRecord;
}
// Web-standard base64 (btoa/atob are globals on BOTH Node 24 and the edge V8
// isolate) — NO Node `Buffer`, so @irisrun/store-do needs no `nodejs_compat` flag on
// Cloudflare Workers. This keeps the edge adapter genuinely edge-native (the
// portability claim). Journal/snapshot records are small, so the per-byte loop is fine.
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class DoStateStore implements StateStore {
  private readonly storage: DoStorage;
  constructor(storage: DoStorage) {
    this.storage = storage;
  }

  // --- key layout (prefix-confined; segments encoded) -----------------------
  private kvKey(key: string): string {
    return `kv/${encodeSegment(key)}`;
  }
  private journalPrefix(sessionId: string): string {
    return `j/${encodeSegment(sessionId)}/`;
  }
  private journalKey(sessionId: string, seq: number): string {
    return `${this.journalPrefix(sessionId)}${padSeq(seq)}`;
  }
  private snapshotPrefix(sessionId: string): string {
    return `snap/${encodeSegment(sessionId)}/`;
  }
  private snapshotKey(sessionId: string, upToSeq: number): string {
    return `${this.snapshotPrefix(sessionId)}${padSeq(upToSeq)}`;
  }
  private fenceKey(sessionId: string): string {
    return `fence/${encodeSegment(sessionId)}`;
  }

  // --- kv / CAS -------------------------------------------------------------
  // A value is a single KvRecord {version, b64}; the current version is read,
  // compared to `expected`, and (if equal) written at version+1 — all inside ONE
  // storage.transaction (atomic, no await on external work between the read and
  // the write). This is a TRUE atomic CAS, which acquireLease rides.

  async load(
    key: string,
  ): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const raw = await this.storage.get(this.kvKey(key));
    if (raw === undefined) return null;
    const rec = decodeKv(raw);
    return { bytes: fromB64(rec.b64), version: rec.version };
  }

  async cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult> {
    const k = this.kvKey(key);
    return this.storage.transaction(async (txn) => {
      const raw = await txn.get(k);
      const current: Version | null = raw === undefined ? null : decodeKv(raw).version;
      if (current !== expected) return { ok: false, current: current ?? 0 };
      const version = (current ?? 0) + 1;
      await txn.put(k, encodeKv({ version, b64: toB64(next) }));
      return { ok: true, version };
    });
  }

  // --- fence (highest fence that has appended; mirrors journal_fence) --------

  private async readFenceTxn(txn: DoStorage, sessionId: string): Promise<Version> {
    const raw = await txn.get(this.fenceKey(sessionId));
    if (raw === undefined) return 0;
    const n = Number(TD.decode(raw));
    return Number.isFinite(n) ? n : 0;
  }

  // --- hwm: DERIVED inside the txn (no mutable sentinel → no read-modify-write
  // race). hwm = max(snapshot.upToSeq, the gap-free journal prefix above it).

  private async snapshotUpToTxn(txn: DoStorage, sessionId: string): Promise<number> {
    const map = await txn.list({ prefix: this.snapshotPrefix(sessionId) });
    let max = -1;
    for (const key of map.keys()) {
      const n = Number(key.slice(this.snapshotPrefix(sessionId).length));
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
    return max;
  }

  private async journalSeqsTxn(txn: DoStorage, sessionId: string): Promise<Set<number>> {
    const prefix = this.journalPrefix(sessionId);
    const map = await txn.list({ prefix });
    const seqs = new Set<number>();
    for (const key of map.keys()) {
      const n = Number(key.slice(prefix.length));
      if (Number.isFinite(n)) seqs.add(n);
    }
    return seqs;
  }

  private async hwmTxn(txn: DoStorage, sessionId: string): Promise<number> {
    const base = await this.snapshotUpToTxn(txn, sessionId); // -1 if none
    const seqs = await this.journalSeqsTxn(txn, sessionId);
    let s = base;
    while (seqs.has(s + 1)) s += 1; // walk the gap-free prefix above the snapshot
    return s;
  }

  // --- append: fenced + dense, compare-and-write inside ONE transaction ------

  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    return this.storage.transaction(async (txn) => {
      // fence FIRST — stale_fence has precedence over seq_conflict (matches the
      // sqlite/fs reference: a superseded writer is rejected as stale even with a
      // wrong seq).
      const storedFence = await this.readFenceTxn(txn, sessionId);
      if (fence < storedFence) {
        return { ok: false, reason: "stale_fence", currentFence: storedFence };
      }
      const last = await this.hwmTxn(txn, sessionId);
      if (last !== expectedSeq - 1) {
        return { ok: false, reason: "seq_conflict", currentSeq: last };
      }
      // dense append at last+1, last+2, … (the txn is exclusive, so no racing
      // writer can occupy a seq between the check and the writes).
      let seq = last;
      for (const bytes of records) {
        seq += 1;
        await txn.put(this.journalKey(sessionId, seq), bytes);
      }
      // raise the fence (no lowering)
      const nextFence = Math.max(storedFence, fence);
      await txn.put(this.fenceKey(sessionId), TE.encode(String(nextFence)));
      return { ok: true, seq };
    });
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const prefix = this.journalPrefix(sessionId);
    const map = await this.storage.list({ prefix });
    const rows: JournalRow[] = [];
    for (const [key, bytes] of map) {
      const seq = Number(key.slice(prefix.length));
      if (Number.isFinite(seq) && seq >= fromSeq) rows.push({ seq, bytes });
    }
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  }

  // --- snapshots ------------------------------------------------------------
  // writeSnapshot SEEDS the hwm implicitly: hwm derives from snapshotUpTo, so
  // writing snap/<sid>/<upToSeq> raises it (the migrate-into-edge contract).

  async writeSnapshot(
    sessionId: string,
    upToSeq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.storage.put(this.snapshotKey(sessionId, upToSeq), bytes);
  }

  async readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const prefix = this.snapshotPrefix(sessionId);
    const map = await this.storage.list({ prefix });
    let upToSeq = -1;
    let bytes: Uint8Array | undefined;
    for (const [key, val] of map) {
      const n = Number(key.slice(prefix.length));
      if (Number.isFinite(n) && n > upToSeq) {
        upToSeq = n;
        bytes = val;
      }
    }
    if (upToSeq < 0 || bytes === undefined) return null;
    return { upToSeq, bytes };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    const prefix = this.journalPrefix(sessionId);
    const map = await this.storage.list({ prefix });
    for (const key of map.keys()) {
      const seq = Number(key.slice(prefix.length));
      if (Number.isFinite(seq) && seq <= throughSeq) await this.storage.delete(key);
    }
  }
}
