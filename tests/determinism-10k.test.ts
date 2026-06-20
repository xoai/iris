import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, canonicalize } from "@irisrun/core";
import type { JournalRecord, Json } from "@irisrun/core";

// B3 — replay determinism over 10k randomized sessions (framework Spec 01 §8).
// Stresses canonicalization (random key order) + replay first-wins dedupe.
// LIMITATION: this cannot catch a reducer that branches on `record.ts` (live and
// replay see the same recorded ts, so divergence is invisible) — that is guarded
// only by the documented ts contract.

interface DState extends Record<string, Json> {
  acc: number;
  seams: string[];
  marks: number;
}
const initial: DState = { acc: 0, seams: [], marks: 0 };

function reducer(state: DState, r: JournalRecord): DState {
  if (r.kind === "effect_result") {
    const p = r.payload as { outcome: { ok: boolean; value?: Json } };
    if (p.outcome.ok && typeof p.outcome.value === "number") {
      return { ...state, acc: state.acc + p.outcome.value };
    }
    return state;
  }
  if (r.kind === "decision") {
    const d = r.payload as { seam: string };
    return { ...state, seams: [...state.seams, d.seam] };
  }
  if (r.kind === "marker") {
    return { ...state, marks: state.marks + 1 };
  }
  return state; // effect_intent no-op
}

// Live incremental fold mirroring replay's first-wins dedupe by effectId.
function liveFold(records: JournalRecord[]): DState[] {
  const states: DState[] = [];
  let s = initial;
  const seen = new Set<string>();
  for (const r of records) {
    if (r.kind === "effect_result") {
      const eid = (r.payload as { effectId: string }).effectId;
      if (seen.has(eid)) {
        states.push(s); // duplicate result: no change (dedupe), state carries forward
        continue;
      }
      seen.add(eid);
    }
    s = reducer(s, r);
    states.push(s);
  }
  return states;
}

const EFFECT_KINDS = ["model_call", "echo", "clock"] as const;
let seqCounter = 0;

// A random value with object keys inserted in random order.
function randValue(depth: number): Json {
  const roll = Math.random();
  if (depth <= 0 || roll < 0.5) return Math.floor(Math.random() * 1000);
  const keys = ["a", "b", "c", "d"].filter(() => Math.random() < 0.7);
  const entries = keys.map((k) => [k, randValue(depth - 1)] as const);
  // shuffle insertion order
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const o: { [k: string]: Json } = {};
  for (const [k, v] of entries) o[k] = v;
  return o;
}

function randJournal(): JournalRecord[] {
  const len = 1 + Math.floor(Math.random() * 18);
  const out: JournalRecord[] = [];
  // small effectId pool → forces duplicate results
  const pool = ["model_call:0", "echo:1", "clock:2", "model_call:3"];
  for (let i = 0; i < len; i++) {
    const seq = seqCounter++;
    const roll = Math.random();
    if (roll < 0.6) {
      const effectId = pool[Math.floor(Math.random() * pool.length)];
      out.push({
        seq,
        ts: Math.floor(Math.random() * 1e6),
        defDigest: "d",
        kind: "effect_result",
        payload: { effectId, outcome: { ok: true, value: Math.floor(Math.random() * 100) } },
      });
    } else if (roll < 0.8) {
      out.push({
        seq,
        ts: seq,
        defDigest: "d",
        kind: "decision",
        payload: { seam: `s${i % 4}`, tacticId: "t", choice: randValue(2) },
      });
    } else {
      out.push({ seq, ts: seq, defDigest: "d", kind: "marker", payload: { marker: "turn_started" } });
    }
  }
  return out;
}

test("B3: 10k randomized sessions — replay is deterministic; dedupe + canonicalization hold", () => {
  const TRIALS = 10_000;
  for (let t = 0; t < TRIALS; t++) {
    seqCounter = 0; // dense, journal-local seqs per trial
    const j = randJournal();

    // (a) replay is a pure function
    assert.equal(canonicalize(replay(initial, j, reducer)), canonicalize(replay(initial, j, reducer)));

    // (b) O(n) live fold (with dedupe) equals replay at the end + 2 spot-checked prefixes
    const live = liveFold(j);
    assert.equal(canonicalize(live[live.length - 1]), canonicalize(replay(initial, j, reducer)));
    for (let s = 0; s < 2; s++) {
      const k = 1 + Math.floor(Math.random() * j.length);
      assert.equal(
        canonicalize(live[k - 1]),
        canonicalize(replay(initial, j.slice(0, k), reducer)),
        "live fold diverged from replay at a prefix",
      );
    }

    // (c) canonicalization is key-order independent
    const v = randValue(3);
    assert.equal(canonicalize(v), canonicalize(shuffleKeys(v)));
  }
});

// Deep-copy a Json value re-inserting object keys in reversed order.
function shuffleKeys(v: Json): Json {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(shuffleKeys);
  const keys = Object.keys(v).reverse();
  const o: { [k: string]: Json } = {};
  for (const k of keys) o[k] = shuffleKeys((v as { [k: string]: Json })[k]);
  return o;
}
