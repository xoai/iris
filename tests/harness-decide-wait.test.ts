// Revision (Gate 3): decideNext may return { wait } — a type-valid seam output
// that must PARK the turn, not crash. The kernel emits the wait, parks, and on
// resume continues the loop (back to assemble). Performers are created once and
// reused across the park/resume (a service persists; only state is durable).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  composeAssemble,
  reactAssembleContext,
} from "@irisrun/core";
import type {
  EngineDeps,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Performer,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };

function deps(store: MemoryStateStore, tactic: Performer, model: Performer): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: { tactic, model_call: model },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("decideNext:{wait} parks the turn on the requested wait; resume continues the loop to finish", async () => {
  const store = new MemoryStateStore();
  // model always returns end_turn (no tools); decideNext waits once, then finishes
  const model = makeScriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
  let decideCount = 0;
  const tactic = makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "decideNext": {
        const choice: Json = decideCount === 0 ? { wait: { kind: "timer", at: 5 } } : "finish";
        decideCount += 1;
        return choice;
      }
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });

  const t1 = await runTurn(deps(store, tactic, model), "s");
  assert.equal(t1.status, "parked", "decideNext{wait} parks the turn");
  assert.deepEqual(t1.status === "parked" ? t1.wait : null, { kind: "timer", at: 5 });

  const t2 = await runTurn(deps(store, tactic, model), "s");
  assert.equal(t2.status, "finished", "resume continues the loop and finishes");
  assert.deepEqual(t2.status === "finished" ? t2.output : null, {
    reply: { role: "assistant", content: "ok", stopReason: "end_turn" },
  });
});
