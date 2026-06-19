// Interactive (chat) harness mode (ADR-0007). A GATED `interactive` flag turns the
// one-shot harness into a durable multi-turn conversation: each user message is
// ingested via a `user_recv` effect (its value supplied per-turn by a performer,
// so it is journaled and replay-deterministic), the conversation accumulates in
// `ctx`, the assistant reply is appended, and the turn PARKS on a `{kind:"user"}`
// wait instead of finishing. Flag OFF → the kernel is byte-identical to today
// (proven here + by the existing migrate-definition / session-pin tests, which run
// a NON-interactive `decideNext → {wait:{kind:"user"}}`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@iris/core";
import type {
  EngineDeps,
  HarnessState,
  HarnessConfig,
  ReadonlyHarnessView,
  ModelContext,
  ModelMessage,
  Performer,
  PerformerRegistry,
  Json,
} from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel, makeFakeModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

// A user_recv performer that delivers one fixed message (the per-turn value).
function userMessage(content: Json): Performer {
  return async (): Promise<{ ok: true; value: Json }> => ({ ok: true, value: { content } });
}

// The default react seam router (assemble passthrough, no compaction, react
// decideNext, allow gate). `gateAction`/`onToolError` are present for the tool test.
function reactRouter(): Performer {
  return makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "decideNext": {
        const pl = payload as { state: ReadonlyHarnessView };
        return composeDecideNext([reactDecideNext()], pl.state);
      }
      case "gateAction":
        return "allow";
      case "onToolError":
        return { action: "giveUp" };
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });
}

function deps(
  store: MemoryStateStore,
  performers: PerformerRegistry,
  config?: HarnessConfig,
  input: { messages: ModelMessage[] } = { messages: [] },
): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(input, config),
    performers,
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

function assistantMessages(state: HarnessState): ModelMessage[] {
  const ctx = state.ctx as ModelContext | null;
  return (ctx?.messages ?? []).filter((m) => m.role === "assistant");
}

// ── 1. Flag-off byte-identity ───────────────────────────────────────────────

test("flag-off: a no-config program finishes with { reply } exactly as today", async () => {
  const store = new MemoryStateStore();
  const model = makeScriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
  const t = await runTurn(
    deps(store, { tactic: reactRouter(), model_call: model }, undefined, {
      messages: [{ role: "user", content: "go" }],
    }),
    "s",
  );
  assert.equal(t.status, "finished");
  assert.deepEqual(t.status === "finished" ? t.output : null, {
    reply: { role: "assistant", content: "ok", stopReason: "end_turn" },
  });
});

// ── 2. Finding-A guard: NON-interactive user-wait resumes to assemble ───────

test("finding-A: a no-config decideNext {wait:{kind:'user'}} parks then resumes to assemble (NOT recv_user)", async () => {
  const store = new MemoryStateStore();
  const model = makeScriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
  let n = 0;
  const tactic = makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "decideNext": {
        const choice: Json = n === 0 ? { wait: { kind: "user" } } : "finish";
        n += 1;
        return choice;
      }
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });
  // NOTE: no user_recv performer registered — if the resume wrongly routed to
  // recv_user it would throw "no performer registered for effect kind 'user_recv'".
  const performers = { tactic, model_call: model };
  const t1 = await runTurn(deps(store, performers, undefined, { messages: [{ role: "user", content: "go" }] }), "s");
  assert.equal(t1.status, "parked");
  assert.deepEqual(t1.status === "parked" ? t1.wait : null, { kind: "user" });

  const t2 = await runTurn(deps(store, performers, undefined, { messages: [{ role: "user", content: "go" }] }), "s");
  assert.equal(t2.status, "finished", "non-interactive user-wait resumed through assemble to finish");
});

// ── 3. Single interactive turn ──────────────────────────────────────────────

test("interactive: one turn ingests the user message, replies, and parks on a user wait", async () => {
  const store = new MemoryStateStore();
  const performers = { tactic: reactRouter(), model_call: makeFakeModel(), user_recv: userMessage("hi") };
  const t = await runTurn(deps(store, performers, { interactive: true }), "s");

  assert.equal(t.status, "parked");
  assert.deepEqual(t.status === "parked" ? t.wait : null, { kind: "user" });
  const state = t.status === "parked" ? t.state : null;
  assert.ok(state);
  assert.equal((state!.modelOut as { content: string }).content, "echo:hi");
  assert.deepEqual((state!.ctx as ModelContext).messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "echo:hi" },
  ]);
});

// ── 4. Multi-turn accumulation: the model sees prior turns ──────────────────

test("interactive: turn 2 sends the accumulated conversation to the model", async () => {
  const store = new MemoryStateStore();
  const captures: ModelMessage[][] = [];
  const recording: Performer = async (request: Json) => {
    const req = request as { messages?: ModelMessage[] };
    captures.push([...(req.messages ?? [])]);
    const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === "user");
    return { ok: true, value: { role: "assistant", content: `echo:${lastUser?.content ?? ""}`, stopReason: "end_turn" } };
  };

  const t1 = await runTurn(
    deps(store, { tactic: reactRouter(), model_call: recording, user_recv: userMessage("hi") }, { interactive: true }),
    "s",
  );
  assert.equal(t1.status, "parked");

  const t2 = await runTurn(
    deps(store, { tactic: reactRouter(), model_call: recording, user_recv: userMessage("again") }, { interactive: true }),
    "s",
  );
  assert.equal(t2.status, "parked");

  // turn-1 model saw [hi]; turn-2 model saw the full accumulated conversation.
  assert.deepEqual(captures[0], [{ role: "user", content: "hi" }]);
  assert.deepEqual(captures[1], [
    { role: "user", content: "hi" },
    { role: "assistant", content: "echo:hi" },
    { role: "user", content: "again" },
  ]);
  const state2 = t2.status === "parked" ? (t2.state as HarnessState) : null;
  assert.equal((state2!.ctx as ModelContext).messages.length, 4);
});

// ── 5. Durable resume: a fresh program instance over the same store ─────────

test("interactive: a brand-new program instance resumes the conversation from the journal", async () => {
  const store = new MemoryStateStore();
  // turn 1 with one program instance
  await runTurn(
    deps(store, { tactic: reactRouter(), model_call: makeFakeModel(), user_recv: userMessage("first") }, { interactive: true }),
    "s",
  );
  // turn 2 with a SEPARATELY-constructed program instance + performers (replay
  // must rebuild the full ctx from the journal alone).
  const t2 = await runTurn(
    deps(store, { tactic: reactRouter(), model_call: makeFakeModel(), user_recv: userMessage("second") }, { interactive: true }),
    "s",
  );
  assert.equal(t2.status, "parked");
  const state = t2.status === "parked" ? (t2.state as HarnessState) : null;
  assert.deepEqual((state!.ctx as ModelContext).messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "echo:first" },
    { role: "user", content: "second" },
    { role: "assistant", content: "echo:second" },
  ]);
});

// ── 6. Malformed user_recv → loud throw ─────────────────────────────────────

test("interactive: a user_recv value without string content throws loudly", async () => {
  const store = new MemoryStateStore();
  const badUser: Performer = async () => ({ ok: true, value: {} });
  await assert.rejects(
    () =>
      runTurn(
        deps(store, { tactic: reactRouter(), model_call: makeFakeModel(), user_recv: badUser }, { interactive: true }),
        "s",
      ),
    /user_recv/,
  );
});

// ── 7. Interactive × tool loop (spec §5.6) ──────────────────────────────────

const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

test("interactive: a tool round runs, the final reply is appended once, and the turn parks on user", async () => {
  const store = new MemoryStateStore();
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const performers = {
    tactic: reactRouter(),
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: tool,
    user_recv: userMessage("do"),
  };
  const t = await runTurn(deps(store, performers, { interactive: true }), "s");

  assert.equal(t.status, "parked");
  assert.deepEqual(t.status === "parked" ? t.wait : null, { kind: "user" });
  assert.equal(log.calls.length, 1, "the gated tool ran exactly once");
  const state = t.status === "parked" ? (t.state as HarnessState) : null;
  // the tool-round assistant message (with tool calls) is NOT appended; only the
  // final no-tool-calls reply is — exactly once.
  assert.deepEqual(assistantMessages(state!), [{ role: "assistant", content: "done" }]);
});
