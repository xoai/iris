// MongoStateStore — the StateStore port over MongoDB. There is NO multi-document
// transaction (so no replica set is required); correctness rests on MongoDB's
// single-document atomicity of the per-session `iris_meta` doc.
//
// The crux is `append`. It is deterministic under concurrency because the stored fence
// is MONOTONIC (it never decreases). So:
//   (1) ensure the meta doc exists;
//   (2) READ the fence first — a read that sees storedFence > fence is permanently
//       authoritative ⇒ stale_fence (this gives stale_fence PRECEDENCE over seq_conflict);
//   (3) a guarded `findOneAndUpdate` that ONLY matches when fence is current AND
//       hwm === expectedSeq-1 reserves the dense seq range in one atomic tick — exactly
//       one concurrent writer can match the `hwm` guard, so exactly one wins;
//   (4) on a win, the journal docs are inserted (the seq range is already reserved).
// Certified by @irisrun/store-conformance.
//
// DURABILITY CAVEAT (crash-atomicity tier — see README "Certify it"): steps (3) and (4)
// are TWO operations, not one transaction (there is no replica set). If the process
// crashes BETWEEN the hwm reservation and the journal insertMany, the hwm is advanced but
// those journal rows are missing — a dense-journal gap. This is NOT silent corruption:
// Iris's engine asserts replay consistency on every step, so the gap surfaces as a LOUD
// replay failure (an operator re-points the session or re-runs), never wrong state. The
// transactional SQL stores (postgres/mysql, one BEGIN/COMMIT) have no such window. A
// deployment that needs strict crash-atomicity should use a replica-set transaction
// (a future opt-in) or a SQL store. The conformance suite cannot exercise a mid-append
// crash, so this tier difference is documented here rather than test-enforced.
import type { StateStore, Version, CasResult, AppendResult, JournalRow } from "@irisrun/core";
import { type MongoLike, type MongoColl, isDuplicateKey, toBuf, toU8 } from "./mongo.ts";

// seqs/versions/fences are well within JS Number range (documented assumption, as in the
// SQL stores).
const num = (v: unknown): number => Number(v);

export class MongoStateStore implements StateStore {
  // Explicit field (NOT a constructor parameter property) — Node's strip-only TS mode,
  // which runs the test suite, does not support parameter properties.
  private readonly db: MongoLike;
  constructor(db: MongoLike) {
    this.db = db;
  }

  private kv(): MongoColl {
    return this.db.collection("iris_kv");
  }
  private meta(): MongoColl {
    return this.db.collection("iris_meta");
  }
  private journal(): MongoColl {
    return this.db.collection("iris_journal");
  }
  private snapshot(): MongoColl {
    return this.db.collection("iris_snapshot");
  }

  async load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const doc = await this.kv().findOne({ _id: key });
    if (!doc) return null;
    return { bytes: toU8(doc.bytes), version: num(doc.version) };
  }

  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    if (expected === null) {
      try {
        await this.kv().insertOne({ _id: key, version: 1, bytes: toBuf(next) });
        return { ok: true, version: 1 };
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        const cur = await this.kv().findOne({ _id: key });
        return { ok: false, current: cur ? num(cur.version) : 0 };
      }
    }
    const res = await this.kv().updateOne(
      { _id: key, version: expected },
      { $set: { bytes: toBuf(next) }, $inc: { version: 1 } },
    );
    if (res.matchedCount === 1) return { ok: true, version: expected + 1 };
    const cur = await this.kv().findOne({ _id: key });
    return { ok: false, current: cur ? num(cur.version) : 0 };
  }

  async append(sessionId: string, expectedSeq: number, records: Uint8Array[], fence: Version): Promise<AppendResult> {
    const meta = this.meta();
    // (1) ensure a meta doc — $setOnInsert leaves an existing doc untouched.
    await meta.updateOne({ _id: sessionId }, { $setOnInsert: { hwm: -1, fence: 0 } }, { upsert: true });

    // (2) FENCE GATE first — the stored fence is monotonic, so a read showing
    //     storedFence > fence is authoritative ⇒ stale_fence (PRECEDENCE over seq_conflict).
    const before = await meta.findOne({ _id: sessionId });
    const storedFence = num(before?.fence ?? 0);
    if (fence < storedFence) {
      return { ok: false, reason: "stale_fence", currentFence: storedFence };
    }

    // (3) SEQ-RESERVE GATE — atomically claim the dense seq range. The filter matches
    //     ONLY when the fence is still current AND hwm === expectedSeq-1, so concurrent
    //     callers serialize on the single meta doc and exactly one matches.
    const newHwm = expectedSeq - 1 + records.length;
    const reserved = await meta.findOneAndUpdate(
      { _id: sessionId, fence: { $lte: fence }, hwm: expectedSeq - 1 },
      [{ $set: { hwm: newHwm, fence: { $max: ["$fence", fence] } } }],
      { returnDocument: "after" },
    );

    if (reserved) {
      // The seq range [expectedSeq, newHwm] is ours. Empty records ⇒ nothing to insert.
      if (records.length > 0) {
        const docs = records.map((bytes, i) => {
          const seq = expectedSeq + i;
          return { _id: `${sessionId}:${seq}`, session: sessionId, seq, bytes: toBuf(bytes) };
        });
        await this.journal().insertMany(docs, { ordered: true });
      }
      return { ok: true, seq: newHwm };
    }

    // (4) Lost the gate — re-read meta to classify. A fence that advanced past ours since
    //     step (2) is still stale_fence (precedence); otherwise it is a seq conflict.
    const after = await meta.findOne({ _id: sessionId });
    const nowFence = num(after?.fence ?? 0);
    const nowHwm = num(after?.hwm ?? -1);
    if (fence < nowFence) {
      return { ok: false, reason: "stale_fence", currentFence: nowFence };
    }
    return { ok: false, reason: "seq_conflict", currentSeq: nowHwm };
  }

  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    const rows = await this.journal()
      .find({ session: sessionId, seq: { $gte: fromSeq } })
      .sort({ seq: 1 })
      .toArray();
    return rows.map((row) => ({ seq: num(row.seq), bytes: toU8(row.bytes) }));
  }

  async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
    await this.snapshot().updateOne(
      { _id: `${sessionId}:${upToSeq}` },
      { $set: { session: sessionId, upToSeq, bytes: toBuf(bytes) } },
      { upsert: true },
    );
    // SEED the hwm so a migrated tail (starting at upToSeq+1) appends densely; a fresh
    // meta doc gets hwm=upToSeq, an existing one is raised to max(hwm, upToSeq). The
    // pipeline form lets a $max reference the (possibly absent) current field.
    await this.meta().updateOne(
      { _id: sessionId },
      [{ $set: { hwm: { $max: [{ $ifNull: ["$hwm", upToSeq] }, upToSeq] }, fence: { $ifNull: ["$fence", 0] } } }],
      { upsert: true },
    );
  }

  async readLatestSnapshot(sessionId: string): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    const rows = await this.snapshot().find({ session: sessionId }).sort({ upToSeq: -1 }).toArray();
    if (rows.length === 0) return null;
    return { upToSeq: num(rows[0].upToSeq), bytes: toU8(rows[0].bytes) };
  }

  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    // rows ≤ throughSeq are dropped; the hwm in iris_meta is untouched (seqs never reused)
    await this.journal().deleteMany({ session: sessionId, seq: { $lte: throughSeq } });
  }
}
