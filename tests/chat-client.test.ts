// The interactive chat client (packages/cli/src/chat.ts). Host-side, zero-dep.
// Part 1 — the model-call wrapper + production fake. Part 2 (renderOutcome +
// runChat) is appended in the REPL task.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentImage } from "@iris/agent";
import type { Performer, Json, HarnessState, TurnOutcome } from "@iris/core";
import { defaultBundle } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import {
  wrapModelForImage,
  makeChatFakeModel,
  makeChatStreamingFakeModel,
  makeStreamSink,
  renderOutcome,
  runChat,
  hitlRequest,
  parseApproval,
  renderHitlRequest,
  renderApprovalResult,
  type ChatDeps,
  type HitlRequest,
} from "iris";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { createApprovalInbox, auditApprovals } from "@iris/auth";
import type { ApprovalPolicy, Principal } from "@iris/auth";

// A minimal literal image: the wrapper only reads agentfile.model,
// agentfile.instructions, and content. `lock` is required by the type but unread.
function fakeImage(model: string, system: string): AgentImage {
  return {
    agentfile: { model, instructions: "instructions.md" },
    lock: {},
    content: { "instructions.md": Buffer.from(system, "utf8").toString("base64") },
  } as unknown as AgentImage;
}

test("wrapModelForImage injects the provider-stripped model id and decoded system prompt", async () => {
  let captured: Json | null = null;
  const spy: Performer = async (request) => {
    captured = request;
    return { ok: true, value: { role: "assistant", content: "ok", stopReason: "end_turn" } };
  };
  const wrapped = wrapModelForImage(spy, fakeImage("anthropic/claude-x", "You are helpful."));
  const out = await wrapped({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(out.ok, true);
  const req = captured as unknown as { model: string; system: string; messages: Json };
  assert.equal(req.model, "claude-x", "the 'anthropic/' provider prefix is stripped");
  assert.equal(req.system, "You are helpful.", "instructions decoded from image.content");
  assert.deepEqual(req.messages, [{ role: "user", content: "hi" }], "the kernel messages pass through");
  assert.equal((req as unknown as { maxTokens: number }).maxTokens, 4096, "a chat-appropriate reply budget is injected");
});

test("wrapModelForImage maps a provider error to a synthetic assistant reply (finding B)", async () => {
  const failing: Performer = async () => ({ ok: false, error: { message: "boom" } });
  const wrapped = wrapModelForImage(failing, fakeImage("anthropic/claude-x", "sys"));
  const out = await wrapped({ messages: [] });

  assert.equal(out.ok, true, "the failure is NOT propagated as ok:false (would poison the journal)");
  const value = out.ok ? (out.value as { role: string; content: string; stopReason: string }) : null;
  assert.equal(value!.role, "assistant");
  assert.match(value!.content, /boom/);
  assert.equal(value!.stopReason, "error");
});

test("makeChatFakeModel echoes the last user message (keyless/install-free path)", async () => {
  const fake = makeChatFakeModel();
  const out = await fake({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(out.ok, true);
  assert.equal(out.ok ? (out.value as { content: string }).content : null, "echo:ping");
});

// --- Part 2: renderOutcome (pure, all TurnOutcome variants) ------------------

function stateWith(content: string): HarnessState {
  return { modelOut: { content } } as unknown as HarnessState;
}

test("renderOutcome: parked/user → agent reply, keep going", () => {
  const r = renderOutcome({ status: "parked", wait: { kind: "user" }, state: stateWith("hi there") });
  assert.equal(r.shouldBreak, false);
  assert.match(r.text, /agent> hi there/);
});

test("renderOutcome: parked/timer and parked/signal → status line, keep going", () => {
  const t = renderOutcome({ status: "parked", wait: { kind: "timer", at: 5 }, state: stateWith("x") });
  assert.equal(t.shouldBreak, false);
  assert.match(t.text, /timer/);
  const s = renderOutcome({ status: "parked", wait: { kind: "signal", name: "hitl:a" }, state: stateWith("x") });
  assert.equal(s.shouldBreak, false);
  assert.match(s.text, /signal:hitl:a/);
});

test("renderOutcome: finished → reply + complete, break", () => {
  const r = renderOutcome({ status: "finished", output: {}, state: stateWith("bye") });
  assert.equal(r.shouldBreak, true);
  assert.match(r.text, /agent> bye/);
  assert.match(r.text, /session complete/);
});

test("renderOutcome: contended → fixed message, break, NO state access", () => {
  const r = renderOutcome({ status: "contended", current: 3 });
  assert.equal(r.shouldBreak, true);
  assert.match(r.text, /another runner/);
});

test("renderOutcome: aborted → names the reason, break", () => {
  const r = renderOutcome({ status: "aborted", reason: "lease_lost", state: stateWith("x") });
  assert.equal(r.shouldBreak, true);
  assert.match(r.text, /aborted/);
  assert.match(r.text, /lease_lost/);
});

// --- Part 2: runChat (integration — real engine + in-memory store) -----------

async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}

function chatDeps(input: string[], out: string[]): ChatDeps {
  return {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "d",
    modelPerformer: makeChatFakeModel(),
    tacticPerformer: defaultBundle().tacticPerformer,
    sessionId: "s",
    input: lines(input),
    output: { write: (s) => void out.push(s) },
  };
}

test("runChat: a message gets an agent reply, then /exit ends cleanly (one turn)", async () => {
  const out: string[] = [];
  await runChat(chatDeps(["hi", "/exit"], out));
  const text = out.join("");
  assert.match(text, /agent> echo:hi/);
  assert.equal((text.match(/agent>/g) ?? []).length, 1, "exactly one turn ran before /exit");
});

test("runChat: end-of-input (EOF) ends the loop like /exit", async () => {
  const out: string[] = [];
  await runChat(chatDeps(["hi"], out));
  assert.match(out.join(""), /agent> echo:hi/);
});

test("runChat: a blank line is skipped (no turn)", async () => {
  const out: string[] = [];
  await runChat(chatDeps(["", "  ", "hi", "/exit"], out));
  assert.equal((out.join("").match(/agent>/g) ?? []).length, 1, "blank lines produced no turn");
});

test("runChat: a failing turn is isolated — the REPL survives and re-prompts", async () => {
  const out: string[] = [];
  const deps = chatDeps(["boom", "hi", "/exit"], out);
  // A model performer that throws → the engine records ok:false → the kernel
  // throws "unhandled effect failure" out of the turn. runChat must catch it,
  // surface it, and keep going (not crash the whole session).
  deps.modelPerformer = async () => {
    throw new Error("provider exploded");
  };
  await runChat(deps); // must NOT reject
  const text = out.join("");
  assert.match(text, /turn failed \(.*provider exploded.*\)/, "the failed turn is surfaced loudly");
  assert.match(text, /session preserved/);
});

test("runChat: /exit and EOF print the durable-resume hint", async () => {
  const a: string[] = [];
  await runChat(chatDeps(["/exit"], a));
  assert.match(a.join(""), /resume later with the same --session/);
  const b: string[] = [];
  await runChat(chatDeps(["hi"], b)); // EOF without /exit
  assert.match(b.join(""), /resume later with the same --session/);
});

// --- streaming: makeStreamSink (pure) ----------------------------------------

function arraySink(out: string[]): { write(s: string): void } {
  return { write: (s) => void out.push(s) };
}

test("makeStreamSink: first non-empty delta writes the prefix, later deltas don't", () => {
  const out: string[] = [];
  const sink = makeStreamSink(arraySink(out));
  sink.begin();
  assert.equal(sink.wroteAny(), false);
  sink.onDelta("Hel");
  sink.onDelta("lo");
  assert.equal(sink.wroteAny(), true);
  assert.equal(out.join(""), "agent> Hello", "prefix once, then concatenated deltas");
});

test("makeStreamSink: an empty delta is ignored — no spurious prefix, wroteAny stays false", () => {
  const out: string[] = [];
  const sink = makeStreamSink(arraySink(out));
  sink.begin();
  sink.onDelta("");
  assert.equal(sink.wroteAny(), false);
  assert.equal(out.join(""), "");
});

test("makeStreamSink: begin() resets wroteAny and re-emits the prefix on the next turn", () => {
  const out: string[] = [];
  const sink = makeStreamSink(arraySink(out));
  sink.begin();
  sink.onDelta("a");
  sink.begin();
  assert.equal(sink.wroteAny(), false, "begin() resets per-turn state");
  sink.onDelta("b");
  assert.equal(out.join(""), "agent> aagent> b", "prefix re-emitted for the second turn");
});

// --- streaming: renderOutcome streamed branch --------------------------------

test("renderOutcome streamed: parked/user → just a newline (reply already streamed)", () => {
  const r = renderOutcome(
    { status: "parked", wait: { kind: "user" }, state: stateWith("hi there") },
    { streamed: true },
  );
  assert.equal(r.shouldBreak, false);
  assert.equal(r.text, "\n");
  assert.doesNotMatch(r.text, /hi there/, "the reply is NOT re-printed");
});

test("renderOutcome streamed: parked/user + stopReason error → error surfaced on its own line", () => {
  const state = {
    modelOut: { content: "⚠️ model error: boom", stopReason: "error" },
  } as unknown as HarnessState;
  const r = renderOutcome({ status: "parked", wait: { kind: "user" }, state }, { streamed: true });
  assert.equal(r.text, "\n⚠️ model error: boom\n", "newline then the error content");
  assert.equal(r.shouldBreak, false);
});

test("renderOutcome streamed: finished → newline + complete marker, no reply re-print", () => {
  const r = renderOutcome({ status: "finished", output: {}, state: stateWith("bye") }, { streamed: true });
  assert.equal(r.text, "\n(session complete)\n");
  assert.equal(r.shouldBreak, true);
  assert.doesNotMatch(r.text, /bye/);
});

test("renderOutcome streamed: parked/timer → leading newline then the status line", () => {
  const r = renderOutcome(
    { status: "parked", wait: { kind: "timer", at: 5 }, state: stateWith("x") },
    { streamed: true },
  );
  assert.equal(r.shouldBreak, false);
  assert.match(r.text, /^\n… agent parked \(timer@5\)/);
});

// --- streaming: keyless streaming fake ---------------------------------------

test("makeChatStreamingFakeModel: streams the echo reply in chunks; deltas reconcile with content", async () => {
  const deltas: string[] = [];
  const fake = makeChatStreamingFakeModel((t) => void deltas.push(t));
  const out = await fake({ messages: [{ role: "user", content: "hi there" }] });
  assert.equal(out.ok, true);
  const content = out.ok ? (out.value as { content: string }).content : "";
  assert.equal(content, "echo:hi there", "same format as makeChatFakeModel");
  assert.ok(deltas.length >= 1, "at least one delta fired");
  assert.equal(deltas.join(""), content, "join(deltas) == buffered content (reconcile invariant)");
});

// --- streaming: runChat integration ------------------------------------------

function streamingDeps(input: string[], out: string[]): ChatDeps {
  const output = arraySink(out);
  const sink = makeStreamSink(output);
  return {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "d",
    modelPerformer: makeChatStreamingFakeModel(sink.onDelta),
    tacticPerformer: defaultBundle().tacticPerformer,
    sessionId: "s",
    input: lines(input),
    output,
    streamSink: sink,
  };
}

test("runChat streaming: one message streams the reply exactly once (no double-print)", async () => {
  const out: string[] = [];
  await runChat(streamingDeps(["hi", "/exit"], out));
  const text = out.join("");
  assert.equal((text.match(/agent> /g) ?? []).length, 1, "exactly one agent> prefix");
  assert.equal((text.match(/echo:hi/g) ?? []).length, 1, "reply text appears exactly once");
  assert.match(text, /agent> echo:hi\n/, "streamed reply followed by a closing newline");
});

test("runChat streaming: resume does NOT re-stream history (second turn streams only the new reply)", async () => {
  const out: string[] = [];
  const output = arraySink(out);
  const sink = makeStreamSink(output);
  const store = new MemoryStateStore();
  const scheduler = new MemoryScheduler();
  const base = {
    store,
    scheduler,
    clock: new TestClock(1),
    defDigest: "d",
    modelPerformer: makeChatStreamingFakeModel(sink.onDelta),
    tacticPerformer: defaultBundle().tacticPerformer,
    sessionId: "s",
    output,
    streamSink: sink,
  };
  // Turn 1 ends at EOF; the durable session stays in `store`.
  await runChat({ ...base, input: lines(["one"]) });
  const afterTurn1 = out.length;
  // Turn 2 resumes the SAME session — runTurn replays turn 1 from the journal,
  // which folds the buffered effect_result via the reducer and never re-fires the
  // model performer, so onDelta does not re-emit the first reply.
  await runChat({ ...base, input: lines(["two"]) });
  const turn2 = out.slice(afterTurn1).join("");
  assert.match(turn2, /echo:two/, "turn 2 streams the new reply");
  assert.doesNotMatch(turn2, /echo:one/, "turn 2 does NOT re-stream the first reply");
  assert.equal((out.join("").match(/echo:one/g) ?? []).length, 1, "first reply streamed exactly once overall");
});

test("runChat streaming: a pre-stream model error falls back to a buffered, visible reply", async () => {
  const out: string[] = [];
  const output = arraySink(out);
  const sink = makeStreamSink(output);
  const deps: ChatDeps = {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "d",
    // The base returns ok:false BEFORE any delta; wrapModelForImage absorbs it
    // into a synthetic ok:true (stopReason "error") reply. wroteAny() stays false
    // → renderOutcome uses the buffered path so the error is visible.
    modelPerformer: wrapModelForImage(
      async () => ({ ok: false, error: { message: "boom" } }),
      fakeImage("anthropic/claude-x", "sys"),
    ),
    tacticPerformer: defaultBundle().tacticPerformer,
    sessionId: "s",
    input: lines(["hi", "/exit"]),
    output,
    streamSink: sink,
  };
  await runChat(deps);
  const text = out.join("");
  assert.match(text, /agent> ⚠️ model error: boom/, "the error is visible via the buffered fallback");
  assert.equal((text.match(/agent> /g) ?? []).length, 1, "no spurious prefix from the empty stream");
});

// --- in-chat HITL: pure helpers ----------------------------------------------

test("hitlRequest: a hitl signal park returns the pending tool call (name + args)", () => {
  const state = {
    modelOut: { toolCalls: [{ callId: "x", name: "rm", args: { path: "/tmp/a" } }] },
    toolCursor: 0,
  } as unknown as HarnessState;
  const r = hitlRequest({ status: "parked", wait: { kind: "signal", name: "hitl:x" }, state });
  assert.deepEqual(r, { callId: "x", name: "rm", args: { path: "/tmp/a" } });
});

test("hitlRequest: null for user park / non-hitl signal / finished; never throws on malformed state", () => {
  assert.equal(
    hitlRequest({ status: "parked", wait: { kind: "user" }, state: stateWith("x") }),
    null,
  );
  assert.equal(
    hitlRequest({ status: "parked", wait: { kind: "signal", name: "other" }, state: stateWith("x") }),
    null,
  );
  assert.equal(hitlRequest({ status: "finished", output: {}, state: stateWith("x") }), null);
  assert.equal(hitlRequest({ status: "contended", current: 1 }), null);
  // malformed modelOut → still yields the callId so the human can decide; empty name.
  const bad = hitlRequest({
    status: "parked",
    wait: { kind: "signal", name: "hitl:z" },
    state: { modelOut: null, toolCursor: 0 } as unknown as HarnessState,
  });
  assert.deepEqual(bad, { callId: "z", name: "", args: null });
});

test("parseApproval: y/yes/approve/a → approve; n/no/deny/d → deny; else null", () => {
  for (const s of ["y", "Y", "yes", "approve", "a", " Yes "]) assert.equal(parseApproval(s), "approve");
  for (const s of ["n", "N", "no", "deny", "d", " DENY "]) assert.equal(parseApproval(s), "deny");
  for (const s of ["", "maybe", "ok", "yep", "/exit"]) assert.equal(parseApproval(s), null);
});

test("renderHitlRequest: names the tool + args and prompts y/n; streamed leads with a newline", () => {
  const r = renderHitlRequest({ callId: "x", name: "rm", args: { p: 1 } });
  assert.match(r, /rm/);
  assert.match(r, /\[y\/n\]/);
  assert.equal(r.startsWith("\n"), false, "not newline-led when not streamed");
  const s = renderHitlRequest({ callId: "x", name: "rm", args: null }, { streamed: true });
  assert.equal(s.startsWith("\n"), true, "newline-led to close a streamed line");
});

test("renderApprovalResult: ran → running; deny → skipping; unauthorized → skipping + reason", () => {
  assert.match(renderApprovalResult({ intent: "approve", ran: true, reason: "approved by 'local'" }), /running the tool/);
  assert.match(renderApprovalResult({ intent: "deny", ran: false, reason: "denied by 'x'" }), /skipping the tool/);
  const u = renderApprovalResult({ intent: "approve", ran: false, reason: "unauthorized: nope" });
  assert.match(u, /not authorized/);
  assert.match(u, /unauthorized: nope/);
});

// --- in-chat HITL: runChat integration ---------------------------------------

// A scripted model: first a tool call (gated to "ask" by the default bundle), then a
// plain reply. BOTH approve and deny re-invoke the model once on resume (modelOut still
// carries toolCalls → reactDecideNext "continue"), so 2 items serve both paths.
const TOOL_THEN_DONE: Json[] = [
  {
    role: "assistant",
    content: "I'll run it",
    toolCalls: [{ callId: "x", name: "rm", args: { path: "/tmp/a" } }],
    stopReason: "tool_use",
  },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function hitlDeps(opts: {
  input: string[];
  out: string[];
  log?: ToolCallLog;
  policy?: ApprovalPolicy;
  principal?: Principal;
  store?: MemoryStateStore;
}): ChatDeps {
  return {
    store: opts.store ?? new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "d",
    modelPerformer: makeScriptedModel(TOOL_THEN_DONE),
    tacticPerformer: defaultBundle().tacticPerformer, // no safeTools → "rm" gates to "ask"
    toolPerformer: makeFakeTool(() => ({ ok: true, value: { ok: 1 } }), opts.log),
    sessionId: "s",
    input: lines(opts.input),
    output: { write: (s) => void opts.out.push(s) },
    governance: { policy: opts.policy ?? { rules: [], default: "permit" }, inbox: createApprovalInbox() },
    ...(opts.principal ? { principal: opts.principal } : {}),
  };
}

test("runChat HITL: approve runs the gated tool and the conversation continues", async () => {
  const out: string[] = [];
  const log: ToolCallLog = { calls: [] };
  await runChat(hitlDeps({ input: ["please rm", "y", "/exit"], out, log }));
  const text = out.join("");
  assert.match(text, /approval needed/i, "the pending call is surfaced");
  assert.match(text, /'rm'/, "the tool name is shown");
  assert.match(text, /running the tool/i, "the approve verdict is shown");
  assert.equal(log.calls.length, 1, "the approved tool ran exactly once");
  assert.match(text, /agent> done/, "the follow-up reply renders");
});

test("runChat HITL: deny skips the tool; the loop continues", async () => {
  const out: string[] = [];
  const log: ToolCallLog = { calls: [] };
  await runChat(hitlDeps({ input: ["please rm", "n", "/exit"], out, log }));
  const text = out.join("");
  assert.equal(log.calls.length, 0, "the denied tool never ran");
  assert.match(text, /skipping the tool/i, "the deny verdict is shown");
  assert.match(text, /agent> done/, "the loop still continues to the next reply");
});

test("runChat HITL: an invalid approval line re-prompts without consuming the park", async () => {
  const out: string[] = [];
  const log: ToolCallLog = { calls: [] };
  await runChat(hitlDeps({ input: ["please rm", "maybe", "y", "/exit"], out, log }));
  const text = out.join("");
  assert.match(text, /answer y .*or n/i, "an invalid answer re-prompts");
  assert.equal(log.calls.length, 1, "the tool runs after the subsequent valid answer");
});

test("runChat HITL: the approval is journaled as a GovernedApproval (auditable)", async () => {
  const out: string[] = [];
  const store = new MemoryStateStore();
  await runChat(hitlDeps({ input: ["please rm", "y", "/exit"], out, store }));
  const entries = await auditApprovals(store, "s");
  assert.equal(entries.length, 1, "exactly one approval recorded in the journal");
  const e = entries[0];
  assert.equal(e.approved, true);
  assert.equal(e.intent, "approve");
  assert.equal(e.tool, "rm");
  assert.equal(e.principal?.id, "local");
  assert.match(e.reason ?? "", /approved by 'local'/);
});

test("runChat HITL: a policy that denies the principal skips the tool on approve (reason surfaced)", async () => {
  const out: string[] = [];
  const log: ToolCallLog = { calls: [] };
  const policy: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }], default: "deny" };
  await runChat(
    hitlDeps({
      input: ["please rm", "y", "/exit"],
      out,
      log,
      policy,
      principal: { id: "stranger", roles: ["guest"] },
    }),
  );
  const text = out.join("");
  assert.equal(log.calls.length, 0, "an unauthorized approve does not run the tool");
  assert.match(text, /not authorized/i, "the unauthorized verdict is shown");
  assert.match(text, /unauthorized/i, "the policy reason is surfaced");
});

test("runChat HITL: a streamed tool-call turn closes its line before the approval prompt", async () => {
  const out: string[] = [];
  const output = arraySink(out);
  const sink = makeStreamSink(output);
  // Bespoke 2-call streaming model: call #1 streams content AND returns a tool call;
  // call #2 streams the plain reply. (The shipped streaming fakes never emit toolCalls.)
  const toolMsg: Json = {
    role: "assistant",
    content: "I'll run it",
    toolCalls: [{ callId: "x", name: "rm", args: {} }],
    stopReason: "tool_use",
  };
  const doneMsg: Json = { role: "assistant", content: "done", stopReason: "end_turn" };
  let call = 0;
  const streamingToolThenDone: import("@iris/core").Performer = async () => {
    if (call++ === 0) {
      sink.onDelta("I'll ");
      sink.onDelta("run it");
      return { ok: true, value: toolMsg };
    }
    sink.onDelta("done");
    return { ok: true, value: doneMsg };
  };
  const deps: ChatDeps = {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "d",
    modelPerformer: streamingToolThenDone,
    tacticPerformer: defaultBundle().tacticPerformer,
    toolPerformer: makeFakeTool(() => ({ ok: true, value: { ok: 1 } })),
    sessionId: "s",
    input: lines(["go", "y", "/exit"]),
    output,
    streamSink: sink,
    governance: { policy: { rules: [], default: "permit" }, inbox: createApprovalInbox() },
  };
  await runChat(deps);
  const text = out.join("");
  assert.match(text, /agent> I'll run it/, "the tool-call turn streamed its content");
  assert.match(text, /\n⚠️ approval needed/, "the approval prompt is newline-led after streamed content");
  assert.equal((text.match(/run it/g) ?? []).length, 1, "the streamed content is not double-printed");
  assert.match(text, /agent> done/, "the resumed reply streams once");
});

test("runChat HITL: EOF while an approval is pending leaves the session parked (no decision)", async () => {
  const out: string[] = [];
  const log: ToolCallLog = { calls: [] };
  await runChat(hitlDeps({ input: ["please rm"], out, log })); // EOF before answering
  const text = out.join("");
  assert.equal(log.calls.length, 0, "no tool runs without a recorded decision");
  assert.match(text, /awaiting your approval/i, "the parked-awaiting-approval hint is printed");
});

test("runChat HITL: with NO governance, a tool-call park renders the legacy not-resumable line", async () => {
  const out: string[] = [];
  const deps = hitlDeps({ input: ["please rm", "/exit"], out });
  delete (deps as { governance?: unknown }).governance; // the ungoverned path
  await runChat(deps);
  const text = out.join("");
  assert.match(text, /not resumable from chat yet/, "the legacy ungoverned render is unchanged");
});
