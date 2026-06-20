// P2-9 (C3) — driveToCompletion: runs a CHILD harness session to a terminal state and
// maps the engine's TurnOutcome to a ChildOutcome. Covers finished, parked (not
// force-driven), exhausted (perpetually contended), aborted (lease lost), and lazy child
// creation (a fresh sessionId is created from program.initial by its first turn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@iris/core";
import type { HostAdapter } from "@iris/host";
import type { PerformerRegistry, Json, HarnessState, StateStore } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeContendedStore, makeAbortOnAppendStore } from "./lib/flaky-store.ts";
import { driveToCompletion } from "@iris/subagents";

const INPUT = { messages: [{ role: "user", content: "hi" }] };
const REPLY: Json = { role: "assistant", content: "child-done", stopReason: "end_turn" };

function host(store: StateStore): HostAdapter {
  return { name: "child-host", capabilities: { long_running: true }, store, scheduler: new MemoryScheduler() };
}

function childPerformers(): PerformerRegistry {
  return {
    tactic: defaultBundle().tacticPerformer,
    model_call: makeScriptedModel([REPLY]),
    // present so an interactive child can ingest its first message then park on the next
    // user wait; never called by a non-interactive child.
    user_recv: async () => ({ ok: true, value: { content: "hello" } }),
  };
}

function deps(store: StateStore, opts: { interactive?: boolean; maxTurns?: number } = {}) {
  return {
    host: host(store),
    defDigest: "child-def",
    program: harnessProgram(INPUT, opts.interactive ? { interactive: true } : {}),
    performers: childPerformers(),
    clock: new TestClock(1),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  };
}

test("driveToCompletion: a non-interactive child finishes in one turn (output carried back)", async () => {
  const store = new MemoryStateStore();
  const out = await driveToCompletion<HarnessState>("child-1", deps(store));
  assert.equal(out.status, "finished");
  // The harness finish output is { reply: <modelOut> }.
  assert.deepEqual(out.status === "finished" ? out.output : null, { reply: REPLY });
});

test("driveToCompletion: lazy creation — a fresh child sessionId is created and journaled", async () => {
  const store = new MemoryStateStore();
  const out = await driveToCompletion<HarnessState>("never-seen-before", deps(store));
  assert.equal(out.status, "finished");
  const rows = await store.readJournal("never-seen-before", 0);
  assert.ok(rows.length > 0, "the child session now has a durable journal");
});

test("driveToCompletion: an interactive child PARKS (returned, not force-driven)", async () => {
  const store = new MemoryStateStore();
  const out = await driveToCompletion<HarnessState>("child-park", deps(store, { interactive: true }));
  assert.equal(out.status, "parked");
  assert.deepEqual(out.status === "parked" ? out.wait : null, { kind: "user" });
});

test("driveToCompletion: a perpetually contended lease → exhausted within maxTurns, warning each retry", async () => {
  const store = makeContendedStore(new MemoryStateStore());
  const warnings: string[] = [];
  const out = await driveToCompletion<HarnessState>("child-busy", {
    ...deps(store, { maxTurns: 3 }),
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(out.status, "exhausted");
  assert.equal(out.status === "exhausted" ? out.turns : -1, 3);
  assert.equal(warnings.length, 3, "each contended retry is surfaced via onWarn (observability)");
  assert.match(warnings[0], /contended on turn 1\/3/);
});

test("driveToCompletion: a lost lease (stale fence on append) → aborted", async () => {
  const { store } = makeAbortOnAppendStore(new MemoryStateStore());
  const out = await driveToCompletion<HarnessState>("child-abort", deps(store, { maxTurns: 1 }));
  assert.equal(out.status, "aborted");
  assert.equal(out.status === "aborted" ? out.reason : null, "lease_lost");
});

test("driveToCompletion: maxTurns must be a positive integer (boundary guard)", async () => {
  const store = new MemoryStateStore();
  await assert.rejects(
    () => driveToCompletion<HarnessState>("child-x", deps(store, { maxTurns: 0 })),
    /maxTurns must be a positive integer/,
  );
});
