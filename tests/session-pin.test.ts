// T7 — session pinning + hold (spec §3.7). Builds a REAL parked runTurn journal,
// then asserts governingDigest reads the pin, a never-started session is null, and
// a live session HOLDS its pin while a new session adopts a new image digest.
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
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { governingDigest } from "@irisrun/agent";

const INPUT = { messages: [{ role: "user", content: "hi" }] };
const MODEL_OUT: Json[] = [{ role: "assistant", content: "hello", stopReason: "end_turn" }];

// A turn that parks on a `user` wait (the between-turns boundary).
function deps(store: MemoryStateStore, defDigest: string): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact":
            return false;
          case "decideNext":
            return { wait: { kind: "user" } };
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(MODEL_OUT),
    },
    defDigest,
    holderId: "H",
    assertReplay: true,
  };
}

test("T7: a never-started session has null governing digest", async () => {
  const store = new MemoryStateStore();
  assert.equal(await governingDigest(store, "s"), null);
});

test("T7: a turn pins the image digest; a live session holds it while a new session adopts a new digest", async () => {
  const store = new MemoryStateStore();
  const t = await runTurn(deps(store, "imgA"), "s");
  assert.equal(t.status, "parked");
  assert.equal(await governingDigest(store, "s"), "imgA", "session s pinned to imgA");

  // a NEW session started under a redeployed image imgB adopts imgB...
  const t2 = await runTurn(deps(store, "imgB"), "s2");
  assert.equal(t2.status, "parked");
  assert.equal(await governingDigest(store, "s2"), "imgB", "new session s2 adopts imgB");

  // ...while the live session s STILL holds imgA (the redeploy did not move its pin)
  assert.equal(await governingDigest(store, "s"), "imgA", "live session s held imgA across the redeploy");
});
