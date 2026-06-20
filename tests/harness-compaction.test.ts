// Task 7 — C2: when the context exceeds budget, shouldCompact (the
// window-compaction tactic) returns the COMPACTED context as its decision. That
// decision is the tactic effect's journaled result value, folded into
// HarnessState.ctx — so replay reproduces the compacted context exactly, without
// re-running the compactor (the compactor is never called on replay).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
  windowCompaction,
} from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  EffectResult,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Budget,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";

const INPUT = {
  messages: [
    { role: "user", content: "m1" },
    { role: "assistant", content: "m2" },
    { role: "user", content: "m3" },
  ],
};
const COMPACTED = [
  { role: "assistant", content: "m2" },
  { role: "user", content: "m3" },
];

function deps(store: MemoryStateStore): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { budget: { tokens: 2 } }),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact": {
            const pl = payload as { ctx: ModelContext; budget: Budget };
            return windowCompaction(2).decide(pl);
          }
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel([{ role: "assistant", content: "done", stopReason: "end_turn" }]),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C2: shouldCompact compacts an over-budget context; the compacted ctx is journaled + replays exactly", async () => {
  const store = new MemoryStateStore();
  const t = await runTurn(deps(store), "s");
  assert.equal(t.status, "finished");

  // the live state adopted the compacted context (trailing window of 2)
  const finalCtx = (t.status === "finished" ? (t.state as HarnessState).ctx : null) as ModelContext;
  assert.deepEqual(finalCtx.messages, COMPACTED, "state holds the compacted context");

  // the compaction decision is the journaled shouldCompact tactic result VALUE
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const compactionResult = records
    .filter((r) => r.kind === "effect_result")
    .map((r) => (r.payload as EffectResult).outcome)
    .find((o) => o.ok && (o.value as { seam?: string }).seam === "shouldCompact");
  assert.ok(compactionResult && compactionResult.ok, "a shouldCompact result is journaled");
  assert.deepEqual(
    (compactionResult.value as { choice: Json }).choice,
    { messages: COMPACTED, tokens: 2 },
    "the journaled decision carries the compacted context",
  );

  // C2/C6: replay reproduces the compacted state without re-running the compactor
  // (replay folds the journaled result; it never calls a performer/tactic)
  const program = harnessProgram(INPUT, { budget: { tokens: 2 } });
  assert.equal(
    canonicalize(replay(program.initial, records, program.reducer)),
    canonicalize(t.status === "finished" ? t.state : program.initial),
  );
});
