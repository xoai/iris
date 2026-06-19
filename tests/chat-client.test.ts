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
  renderOutcome,
  runChat,
  type ChatDeps,
} from "@iris/cli";

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
