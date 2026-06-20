import { test } from "node:test";
import assert from "node:assert/strict";
import { effectId } from "@irisrun/core";

test("effectId: deterministic for the same (seq, kind)", () => {
  assert.equal(effectId(7, "echo"), effectId(7, "echo"));
});

test("effectId: distinct seqs produce distinct ids", () => {
  const ids = new Set<string>();
  for (let seq = 0; seq < 1000; seq++) ids.add(effectId(seq, "clock"));
  assert.equal(ids.size, 1000, "collision among distinct seqs");
});

test("effectId: collision-free across kinds and a seq range", () => {
  const ids = new Set<string>();
  const kinds = ["clock", "echo", "model_call"] as const;
  for (const k of kinds) {
    for (let seq = 0; seq < 200; seq++) ids.add(effectId(seq, k));
  }
  assert.equal(ids.size, kinds.length * 200);
});

test("effectId: rejects invalid seq (boundary guard)", () => {
  assert.throws(() => effectId(-1, "echo"), /non-negative integer/);
  assert.throws(() => effectId(1.5, "echo"), /non-negative integer/);
});
