// Task 4: the kernel is a Program<HarnessState> over the EXISTING runTurn
// (ZERO engine change). This proves the no-tool spine of the phase machine:
// assemble → maybe_compact(false) → await_model → decide_next(finish) → done.
// Every seam consultation is a `tactic` effect; replay reconstructs byte-identical
// state with no performer (C6, assertReplay ON); resume re-invokes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, replay, canonicalize, decode, harnessProgram } from "@irisrun/core";
import type { EngineDeps, JournalRecord, EffectIntent, HarnessState } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeFakeModel, type CallCounter } from "./lib/fake-model.ts";
import { makeFakeTacticBySeam } from "./lib/fake-tactic.ts";

const INPUT = { messages: [{ role: "user", content: "hi" }] };

function deps(
  store: MemoryStateStore,
  tacticCounter: CallCounter,
  modelCounter: CallCounter,
): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: makeFakeTacticBySeam(
        {
          assembleContext: { messages: [{ role: "user", content: "hi" }] },
          shouldCompact: false,
          decideNext: "finish",
        },
        tacticCounter,
      ),
      model_call: makeFakeModel(modelCounter),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true, // C6: the always-on replay assertion fires after every step
  };
}

test("kernel no-tool path runs assemble→model→decide→finish; every seam decision is a journaled effect", async () => {
  const store = new MemoryStateStore();
  const tc: CallCounter = { n: 0 };
  const mc: CallCounter = { n: 0 };

  const t1 = await runTurn(deps(store, tc, mc), "s");
  assert.equal(t1.status, "finished");
  assert.deepEqual(t1.status === "finished" ? t1.output : null, {
    reply: { role: "assistant", content: "echo:hi", stopReason: "end_turn" },
  });
  assert.equal(tc.n, 3, "assembleContext + shouldCompact + decideNext consulted once each");
  assert.equal(mc.n, 1, "model called once");

  // every seam consultation is journaled as a `tactic` effect (3 intents)
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const tacticIntents = records.filter(
    (r) => r.kind === "effect_intent" && (r.payload as EffectIntent).effectKind === "tactic",
  );
  assert.equal(tacticIntents.length, 3, "three tactic effect_intents journaled");

  // C6: pure replay reconstructs live state with NO performer
  const program = harnessProgram(INPUT);
  const replayed = replay(program.initial, records, program.reducer);
  assert.equal(
    canonicalize(replayed),
    canonicalize(t1.status === "finished" ? t1.state : program.initial),
  );

  // resume → no tactic/model re-invocation, identical output
  const t2 = await runTurn(deps(store, tc, mc), "s");
  assert.equal(t2.status, "finished");
  assert.deepEqual(
    t2.status === "finished" ? t2.output : null,
    t1.status === "finished" ? t1.output : null,
  );
  assert.equal(tc.n, 3, "resume must not re-consult tactics");
  assert.equal(mc.n, 1, "resume must not re-call the model");
});
