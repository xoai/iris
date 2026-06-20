// P2-9 (C2) — makeSubagentPerformer: maps a delegating ToolCall to the parent's effect
// result. Asserts the journal-poison-safe split: finished/parked/exhausted → {ok:true,...};
// aborted/unknown/malformed → {ok:false, code}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import type { HostAdapter } from "@irisrun/host";
import type { PerformerRegistry, Json, StateStore, Outcome } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeContendedStore, makeAbortOnAppendStore } from "./lib/flaky-store.ts";
import { makeSubagentPerformer, type ResolvedChild } from "@irisrun/subagents";

const INPUT = { messages: [{ role: "user", content: "hi" }] };
const REPLY: Json = { role: "assistant", content: "child-done", stopReason: "end_turn" };

function host(store: StateStore): HostAdapter {
  return { name: "child-host", capabilities: { long_running: true }, store, scheduler: new MemoryScheduler() };
}
function perfs(): PerformerRegistry {
  return {
    tactic: defaultBundle().tacticPerformer,
    model_call: makeScriptedModel([REPLY]),
    user_recv: async () => ({ ok: true, value: { content: "hello" } }),
  };
}
function resolved(store: StateStore, opts: { interactive?: boolean; maxTurns?: number } = {}): ResolvedChild {
  return {
    host: host(store),
    defDigest: "child-def",
    program: harnessProgram(INPUT, opts.interactive ? { interactive: true } : {}),
    performers: perfs(),
    clock: new TestClock(1),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  };
}

const DELEGATE: Json = { callId: "c1", name: "delegate", args: { task: "do it" } };

test("performer: finished child → {ok:true, status:finished, output, deterministic sessionId}", async () => {
  const perf = makeSubagentPerformer({ parentSessionId: "P", resolveChild: () => resolved(new MemoryStateStore()) });
  const out = (await perf(DELEGATE)) as Extract<Outcome, { ok: true }>;
  assert.equal(out.ok, true);
  const v = out.value as { sessionId: string; status: string; output: Json };
  assert.equal(v.sessionId, "P::sub::c1");
  assert.equal(v.status, "finished");
  assert.deepEqual(v.output, { reply: REPLY });
});

test("performer: parked child → {ok:true, status:parked, wait} (not an error)", async () => {
  const perf = makeSubagentPerformer({
    parentSessionId: "P",
    resolveChild: () => resolved(new MemoryStateStore(), { interactive: true }),
  });
  const out = (await perf(DELEGATE)) as Extract<Outcome, { ok: true }>;
  assert.equal(out.ok, true);
  const v = out.value as { status: string; wait: Json };
  assert.equal(v.status, "parked");
  assert.deepEqual(v.wait, { kind: "user" });
});

test("performer: exhausted child → ABSORBED to {ok:true, status:exhausted, error}", async () => {
  const perf = makeSubagentPerformer({
    parentSessionId: "P",
    resolveChild: () => resolved(makeContendedStore(new MemoryStateStore()), { maxTurns: 2 }),
  });
  const out = (await perf(DELEGATE)) as Extract<Outcome, { ok: true }>;
  assert.equal(out.ok, true, "exhausted is absorbed to ok:true (not an infra failure)");
  const v = out.value as { status: string; error: { message: string } };
  assert.equal(v.status, "exhausted");
  assert.match(v.error.message, /did not finish/);
});

test("performer: aborted child → {ok:false, code:subagent_aborted} (retryable infra failure)", async () => {
  const { store } = makeAbortOnAppendStore(new MemoryStateStore());
  const perf = makeSubagentPerformer({
    parentSessionId: "P",
    resolveChild: () => resolved(store, { maxTurns: 1 }),
  });
  const out = (await perf(DELEGATE)) as Extract<Outcome, { ok: false }>;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "subagent_aborted");
});

test("performer: unknown child agent (resolveChild → null) → {ok:false, code:unknown_subagent}", async () => {
  const perf = makeSubagentPerformer({ parentSessionId: "P", resolveChild: () => null });
  const out = (await perf(DELEGATE)) as Extract<Outcome, { ok: false }>;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unknown_subagent");
});

test("performer: malformed request → {ok:false, code:bad_subagent_request} (loud, no silent success)", async () => {
  const perf = makeSubagentPerformer({ parentSessionId: "P", resolveChild: () => resolved(new MemoryStateStore()) });
  const noCallId = (await perf({ name: "delegate", args: {} })) as Extract<Outcome, { ok: false }>;
  assert.equal(noCallId.error.code, "bad_subagent_request");
  const notObject = (await perf(null)) as Extract<Outcome, { ok: false }>;
  assert.equal(notObject.error.code, "bad_subagent_request");
});
