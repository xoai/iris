import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReplayConsistency,
  ReplayDivergenceError,
} from "@irisrun/core";
import type { JournalRecord, Json } from "@irisrun/core";
import { intentRec, resultRec, rec } from "./lib/journal-helpers.ts";
import { sumReducer, sumInitial } from "./lib/sample-program.ts";

test("A4: assertion passes after every committed step of a clean sequence", () => {
  const journal: JournalRecord[] = [
    intentRec(0, "echo:0", "echo", { n: 2 }),
    resultRec(1, "echo:0", 2),
    intentRec(2, "echo:2", "echo", { n: 3 }),
    resultRec(3, "echo:2", 3),
    rec(4, "marker", { marker: "finish" }),
  ];
  // Simulate the engine: fold each record into live state as it is "committed",
  // and after each commit assert replay(initial, journalSoFar) byte-equals live.
  let live = sumInitial;
  const soFar: JournalRecord[] = [];
  for (const r of journal) {
    live = sumReducer(live, r);
    soFar.push(r);
    assert.doesNotThrow(() =>
      assertReplayConsistency(live, sumInitial, soFar, sumReducer),
    );
  }
  assert.deepEqual(live, { sum: 5, steps: ["+2", "+3"], finished: true });
});

// A reducer that reads a value NOT derived from the journal (an external mutable
// counter). This is exactly the failure mode of a stray Date.now() or a
// hash-map iteration order: each fold yields a different result, so live and
// replay diverge. Deterministic proxy — no timing flake.
let nondet = 0;
interface BadState extends Record<string, Json> {
  nd: number;
}
function badReducer(state: BadState, _r: JournalRecord): BadState {
  nondet += 1;
  return { ...state, nd: nondet };
}

test("A4: assertion FAILS on injected nondeterminism (Date.now/hash-order proxy)", () => {
  nondet = 0;
  const r0 = resultRec(0, "echo:0", 1);
  const initial: BadState = { nd: 0 };
  const live = badReducer(initial, r0); // live fold → nd = 1
  // replay folds the same record again → nd = 2; live != replay → must throw
  assert.throws(
    () => assertReplayConsistency(live, initial, [r0], badReducer),
    ReplayDivergenceError,
  );
});

test("A4: ReplayDivergenceError message shows both states", () => {
  nondet = 100;
  const r0 = resultRec(0, "echo:0", 1);
  const initial: BadState = { nd: 0 };
  const live = badReducer(initial, r0);
  try {
    assertReplayConsistency(live, initial, [r0], badReducer);
    assert.fail("expected divergence");
  } catch (e) {
    assert.ok(e instanceof ReplayDivergenceError);
    assert.match((e as Error).message, /replay:/);
    assert.match((e as Error).message, /live:/);
  }
});
