// P2-8 M2 — verifyReplay()/verifySession(): offline, compliance-grade verification.
// Three SOUND guarantees: (1) structural integrity (dense seq, self-seq vs row
// position, ≤1 result/effectId, result→prior-intent join when complete); (2)
// in-process replay-determinism (fold the retained records twice → canonicalEqual —
// catches in-process reducer nondeterminism, NOT clock/RNG, which is the online
// assertion's job); (3) totality (replay does not throw). No snapshot-fidelity claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, Reducer } from "@irisrun/core";
import { verifyReplay, verifySession, fnv1a32hex } from "@irisrun/audit";
import { rec, intentRec, resultRec } from "./lib/journal-helpers.ts";
import { recordGovernedSession, harnessReducer, harnessInitial } from "./lib/record-governed-session.ts";

const idReducer: Reducer<Json> = (s) => s;

test("verify ok path: a real recorded session is well-formed, replay-deterministic, total", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 64 });
  const v = await verifySession(store, "s", harnessReducer(), { startState: harnessInitial() });
  assert.equal(v.ok, true, `expected ok, issues: ${v.issues.join("; ")}`);
  assert.equal(v.wellFormed, true);
  assert.equal(v.replayDeterministic, true);
  assert.equal(v.total, true);
  assert.equal(v.complete, true);
  assert.ok(v.finalStateDigest && /^[0-9a-f]{8}$/.test(v.finalStateDigest), "finalStateDigest is an 8-char hex");
  assert.deepEqual(v.issues, []);
});

test("verify: a repeated seq (non-dense) → wellFormed:false, ok:false (density check)", () => {
  const recs = [
    rec(0, "marker", { marker: "turn_started" }),
    rec(1, "marker", { marker: "finish" }),
    rec(1, "marker", { marker: "finish" }), // a repeated seq number breaks the dense-monotonic invariant
  ];
  const v = verifyReplay(idReducer, recs, {}, { complete: true, rowSeqs: [0, 1, 1] });
  assert.equal(v.wellFormed, false);
  assert.equal(v.ok, false);
  assert.match(v.issues.join("\n"), /dense|seq/i);
});

test("verify: seq gap → wellFormed:false", () => {
  const recs = [rec(0, "marker", { marker: "turn_started" }), rec(2, "marker", { marker: "finish" })];
  const v = verifyReplay(idReducer, recs, {}, { complete: true, rowSeqs: [0, 2] });
  assert.equal(v.wellFormed, false);
  assert.match(v.issues.join("\n"), /dense|seq/i);
});

test("verify: record self-seq ≠ store row position → wellFormed:false (corruption/desync)", () => {
  const recs = [rec(0, "marker", { marker: "turn_started" }), rec(1, "marker", { marker: "finish" })];
  const v = verifyReplay(idReducer, recs, {}, { complete: true, rowSeqs: [0, 5] });
  assert.equal(v.wellFormed, false);
  assert.match(v.issues.join("\n"), /self-seq|position|row/i);
});

test("verify: missing intent on a COMPLETE journal → wellFormed:false (orphan result)", () => {
  const recs = [resultRec(0, "e1", { x: 1 })];
  const v = verifyReplay(idReducer, recs, {}, { complete: true, rowSeqs: [0] });
  assert.equal(v.wellFormed, false);
  assert.match(v.issues.join("\n"), /intent/i);
});

test("verify: missing intent on a TRUNCATED tail → NO join issue (caveat path holds)", () => {
  // the intent for e1 is in the dropped pre-snapshot prefix — legitimate when !complete
  const recs = [resultRec(5, "e1", { x: 1 })];
  const v = verifyReplay(idReducer, recs, {}, { complete: false, firstSeq: 5, rowSeqs: [5] });
  assert.equal(v.wellFormed, true, "an orphan result is OK when the prefix was truncated");
  assert.equal(v.ok, true);
});

test("verify: ≤1 result per effectId — a duplicate result → wellFormed:false", () => {
  const recs = [
    intentRec(0, "e1", "echo", { v: 1 }),
    resultRec(1, "e1", { v: 1 }),
    resultRec(2, "e1", { v: 1 }),
  ];
  const v = verifyReplay(idReducer, recs, {}, { complete: true, rowSeqs: [0, 1, 2] });
  assert.equal(v.wellFormed, false);
  assert.match(v.issues.join("\n"), /result|effectId|duplicate/i);
});

test("verify: in-process non-deterministic reducer → replayDeterministic:false (total stays true)", () => {
  let counter = 0;
  const nd: Reducer<Json> = (s) => ({ ...(s as Record<string, Json>), c: counter++ });
  const recs = [rec(0, "marker", { marker: "turn_started" })];
  const v = verifyReplay(nd, recs, {}, { complete: true, rowSeqs: [0] });
  assert.equal(v.wellFormed, true);
  assert.equal(v.total, true);
  assert.equal(v.replayDeterministic, false);
  assert.equal(v.ok, false);
});

test("verify: a reducer that throws → total:false, ok:false", () => {
  const boom: Reducer<Json> = () => {
    throw new Error("boom");
  };
  const recs = [rec(0, "marker", { marker: "turn_started" })];
  const v = verifyReplay(boom, recs, {}, { complete: true, rowSeqs: [0] });
  assert.equal(v.total, false);
  assert.equal(v.ok, false);
  assert.match(v.issues.join("\n"), /boom|threw|total/i);
});

test("verify: never-started session is vacuously ok with retainedRange null", () => {
  const v = verifyReplay(idReducer, [], {}, {});
  assert.equal(v.ok, true);
  assert.equal(v.wellFormed, true);
  assert.equal(v.replayDeterministic, true);
  assert.equal(v.total, true);
  assert.equal(v.retainedRange, null);
});

test("fnv1a32hex: deterministic 8-char hex, distinct for distinct inputs", () => {
  assert.equal(fnv1a32hex("hello"), fnv1a32hex("hello"));
  assert.match(fnv1a32hex("hello"), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1a32hex("hello"), fnv1a32hex("hellp"));
  assert.equal(fnv1a32hex(""), fnv1a32hex(""));
});
