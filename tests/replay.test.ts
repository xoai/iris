import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, canonicalize } from "@iris/core";
import type { JournalRecord } from "@iris/core";
import { rec, intentRec, resultRec } from "./lib/journal-helpers.ts";
import { sumReducer, sumInitial, type SumState } from "./lib/sample-program.ts";

test("A4: replay folds a hand-built journal to the expected state", () => {
  const journal: JournalRecord[] = [
    intentRec(0, "echo:0", "echo", { n: 3 }),
    resultRec(1, "echo:0", 3),
    intentRec(2, "echo:2", "echo", { n: 4 }),
    resultRec(3, "echo:2", 4),
    rec(4, "marker", { marker: "finish", output: { total: 7 } }),
  ];
  const state = replay(sumInitial, journal, sumReducer);
  assert.deepEqual(state, { sum: 7, steps: ["+3", "+4"], finished: true });
});

test("A4: effect_intent records are state no-ops", () => {
  const onlyIntent = replay(
    sumInitial,
    [intentRec(0, "echo:0", "echo", { n: 99 })],
    sumReducer,
  );
  assert.deepEqual(onlyIntent, sumInitial);
});

test("A4: decision and marker records fold correctly", () => {
  const journal: JournalRecord[] = [
    rec(0, "decision", { seam: "decideNext", tacticId: "t/1", choice: "continue" }),
    rec(1, "marker", { marker: "turn_started" }),
  ];
  const state = replay(sumInitial, journal, sumReducer);
  assert.deepEqual(state.steps, ["decision:decideNext"]);
  assert.equal(state.finished, false);
});

test("A4: duplicate effect_result for one effectId is folded at most once (dedupe)", () => {
  const journal: JournalRecord[] = [
    intentRec(0, "echo:0", "echo", { n: 5 }),
    resultRec(1, "echo:0", 5),
    resultRec(2, "echo:0", 5), // pathological duplicate
  ];
  const state = replay(sumInitial, journal, sumReducer);
  assert.equal(state.sum, 5, "duplicate result must not double-apply");
});

test("A4: replay is referentially transparent (same input → same output)", () => {
  const journal: JournalRecord[] = [
    resultRec(0, "echo:0", 1),
    resultRec(1, "echo:1", 2),
  ];
  const a = replay(sumInitial, journal, sumReducer);
  const b = replay(sumInitial, journal, sumReducer);
  assert.equal(canonicalize(a), canonicalize(b));
});

test("A4: property — replay is a pure function of the journal (≥100 random sequences)", () => {
  let seqCounter = 0;
  const mk = (): JournalRecord[] => {
    const len = 1 + Math.floor(Math.random() * 12);
    const out: JournalRecord[] = [];
    for (let i = 0; i < len; i++) {
      const seq = seqCounter++;
      const roll = Math.random();
      if (roll < 0.6) {
        out.push(resultRec(seq, `echo:${seq}`, Math.floor(Math.random() * 100)));
      } else if (roll < 0.8) {
        out.push(rec(seq, "decision", { seam: "s", tacticId: "t", choice: i }));
      } else {
        out.push(rec(seq, "marker", { marker: "turn_started" }));
      }
    }
    return out;
  };

  for (let trial = 0; trial < 120; trial++) {
    const j = mk();
    const first: SumState = replay(sumInitial, j, sumReducer);
    const second: SumState = replay(sumInitial, j, sumReducer);
    assert.equal(
      canonicalize(first),
      canonicalize(second),
      "replay diverged on identical input",
    );
    // adding a duplicate of the last result must not change the outcome
    const lastResult = [...j].reverse().find((r) => r.kind === "effect_result");
    if (lastResult) {
      const dup = { ...lastResult, seq: lastResult.seq + 10000 };
      const withDup = replay(sumInitial, [...j, dup], sumReducer);
      assert.equal(canonicalize(withDup), canonicalize(first), "dedupe failed under property test");
    }
  }
});
