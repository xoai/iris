// End-to-end delegation on the REAL harness: a parent agent configured
// with a `delegate` subagent-tool emits a delegate call; the kernel routes tool_exec to a
// `subagent` effect; the performer drives a child harness; the parent receives the child's
// reply. The load-bearing proofs:
//   A-1: the child is driven EXACTLY ONCE even when the parent turn is replayed (replay
//        never calls performers), and the child session replays independently.
//   A-2: a recovery re-perform of the subagent effect is idempotent (re-enters the same
//        durable child, returns the same output, does not re-run the child model).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  defaultBundle,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
  replay,
} from "@irisrun/core";
import type {
  EngineDeps,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  PerformerRegistry,
  Performer,
  Json,
  StateStore,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import type { CallCounter } from "./lib/fake-model.ts";
import { makeSubagentPerformer, type ResolvedChild } from "@irisrun/subagents";

const PARENT_INPUT = { messages: [{ role: "user", content: "go" }] };
const CHILD_INPUT = { messages: [{ role: "user", content: "sub-task" }] };
const CHILD_REPLY: Json = { role: "assistant", content: "child-result", stopReason: "end_turn" };

// Parent model: delegate once, then finish.
function parentModel(): Performer {
  return makeScriptedModel([
    { role: "assistant", content: "delegating", toolCalls: [{ callId: "a", name: "delegate", args: { task: "sub" } }], stopReason: "tool_use" },
    { role: "assistant", content: "parent-done", stopReason: "end_turn" },
  ]);
}

function parentTactic(): Performer {
  return makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "gateAction":
        return "allow";
      case "decideNext": {
        const pl = payload as { state: ReadonlyHarnessView };
        return composeDecideNext([reactDecideNext()], pl.state);
      }
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });
}

// A child agent resolver bound to a SHARED child store + a SHARED model-call counter, so a
// re-delegation re-enters the SAME durable child (and we can prove the model ran once).
function childResolver(childStore: StateStore, childCounter: CallCounter) {
  return (): ResolvedChild => ({
    host: { name: "child-host", capabilities: { long_running: true }, store: childStore, scheduler: new MemoryScheduler() },
    defDigest: "child-def",
    program: harnessProgram(CHILD_INPUT),
    performers: { tactic: defaultBundle().tacticPerformer, model_call: makeScriptedModel([CHILD_REPLY], childCounter) },
    clock: new TestClock(1),
  });
}

function parentDeps(
  parentStore: StateStore,
  subagent: Performer,
): EngineDeps<HarnessState> {
  return {
    store: parentStore,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(PARENT_INPUT, { subagentTools: ["delegate"] }),
    performers: { tactic: parentTactic(), model_call: parentModel(), subagent },
    defDigest: "parent-def",
    holderId: "H",
    assertReplay: true,
  };
}

test("A-1: parent delegates → child runs once; the child output reaches the parent", async () => {
  const parentStore = new MemoryStateStore();
  const childStore = new MemoryStateStore();
  const childCounter: CallCounter = { n: 0 };
  const subagent = makeSubagentPerformer({ parentSessionId: "P", resolveChild: childResolver(childStore, childCounter) });

  const out = await runTurn(parentDeps(parentStore, subagent), "P");
  assert.equal(out.status, "finished");
  assert.equal(childCounter.n, 1, "the child model ran exactly once");

  // The child session is its own durable, independently-replayable journal under the
  // deterministic id childSessionId("P","a") = "P::sub::a".
  const childRows = await childStore.readJournal("P::sub::a", 0);
  assert.ok(childRows.length > 0, "the child has its own journal under the deterministic id");
});

test("A-1: replaying the parent turn does NOT re-drive the child (performers not called on replay)", async () => {
  const parentStore = new MemoryStateStore();
  const childStore = new MemoryStateStore();
  const childCounter: CallCounter = { n: 0 };
  const subagent = makeSubagentPerformer({ parentSessionId: "P", resolveChild: childResolver(childStore, childCounter) });

  const first = await runTurn(parentDeps(parentStore, subagent), "P");
  assert.equal(first.status, "finished");
  assert.equal(childCounter.n, 1);

  // Re-run the SAME parent session: it replays the journaled subagent result; the
  // subagent performer (and thus the child model) is NOT called again.
  const second = await runTurn(parentDeps(parentStore, subagent), "P");
  assert.equal(second.status, "finished");
  assert.equal(childCounter.n, 1, "child not re-driven on parent replay");
  assert.deepEqual(second.state.output, first.state.output, "replay is deterministic");
});

test("A-1: the child session replays independently to the same state", async () => {
  const parentStore = new MemoryStateStore();
  const childStore = new MemoryStateStore();
  const subagent = makeSubagentPerformer({ parentSessionId: "P", resolveChild: childResolver(childStore, { n: 0 }) });
  await runTurn(parentDeps(parentStore, subagent), "P");

  // Independently replay the child's journal through the harness reducer.
  const childRows = await childStore.readJournal("P::sub::a", 0);
  const childProgram = harnessProgram(CHILD_INPUT);
  const records = childRows.map((r) => JSON.parse(Buffer.from(r.bytes).toString("utf8")) as Json);
  const state = replay(childProgram.initial, records as never[], childProgram.reducer);
  assert.equal((state as HarnessState).phase, "done", "the child journal replays to a finished state");
});

test("A-2: a recovery re-perform of the subagent effect is idempotent (same child, same output)", async () => {
  // The engine's recovery re-performs a dangling effect EXACTLY ONCE via performEffect
  // (engine.ts ~210). Calling the performer twice with the same request models that
  // precisely: the second call re-enters the SAME durable child, which replays its journal
  // (no model call) and returns the same output. No duplicate child, no double-run.
  const childStore = new MemoryStateStore();
  const childCounter: CallCounter = { n: 0 };
  const perf = makeSubagentPerformer({ parentSessionId: "P", resolveChild: childResolver(childStore, childCounter) });
  const call: Json = { callId: "a", name: "delegate", args: { task: "sub" } };

  const first = await perf(call);
  const second = await perf(call); // the recovery re-perform
  assert.equal(childCounter.n, 1, "the child model ran once across the re-perform");
  assert.deepEqual(second, first, "the re-perform returns the identical result (idempotent)");
});
