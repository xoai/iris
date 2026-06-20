// C3 — subagent delegation reachable from the CLI. Proves:
//   • loadSubagents parses/validates an optional `subagents.json` (loud on malformed,
//     empty when absent — zero-value-off);
//   • subagentPerformers(undefined,…) === {} (byte-identical when unconfigured);
//   • cmdRun WITH a subagents option routes a model's `delegate` toolCall to a child
//     agent (its own durable session) and the parent turn finishes — the demo.ts shape,
//     but driven through the real cmdRun command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdInit,
  cmdBuild,
  cmdRun,
  chatTurn,
  loadBundledTools,
  loadSubagents,
  subagentPerformers,
  type ChatDeps,
  type CliSubagents,
} from "iris-runtime";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { childSessionId, type ResolvedChild } from "@irisrun/subagents";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));
const scaffoldResolver = async (src: string) => (await loadBundledTools(join(src, "tools"))).resolver;

test("loadSubagents: a valid subagents.json yields entries + names; absent file → empty", async () => {
  const dir = await tmp("iris-sub-cfg-");
  await writeFile(join(dir, "subagents.json"), JSON.stringify([{ name: "delegate", image: "./child" }]));
  const cfg = await loadSubagents(join(dir, "subagents.json"));
  assert.deepEqual(cfg.names, ["delegate"]);
  assert.equal(cfg.entries[0].image, "./child");

  const absent = await loadSubagents(join(dir, "nope.json"));
  assert.deepEqual(absent, { entries: [], names: [] });
});

test("loadSubagents: malformed config fails LOUDLY", async () => {
  const dir = await tmp("iris-sub-bad-");
  const write = async (name: string, body: string): Promise<string> => {
    const p = join(dir, name);
    await writeFile(p, body);
    return p;
  };

  const badJson = await write("a.json", "not json{");
  const notArray = await write("b.json", JSON.stringify({}));
  const noName = await write("c.json", JSON.stringify([{ image: "./x" }]));
  const noImage = await write("d.json", JSON.stringify([{ name: "x" }]));
  const dupName = await write("e.json", JSON.stringify([{ name: "d", image: "./x" }, { name: "d", image: "./y" }]));

  await assert.rejects(() => loadSubagents(badJson), /json/i);
  await assert.rejects(() => loadSubagents(notArray), /array/i);
  await assert.rejects(() => loadSubagents(noName), /name/i);
  await assert.rejects(() => loadSubagents(noImage), /image/i);
  await assert.rejects(() => loadSubagents(dupName), /duplicate/i);
});

test("byte-identity: subagentPerformers(undefined,…) adds no subagent key", () => {
  assert.deepEqual(subagentPerformers(undefined, "s"), {});
  assert.equal(Object.keys(subagentPerformers(undefined, "s")).length, 0);
});

test("cmdRun with subagents: a `delegate` toolCall delegates to a child agent; parent finishes", async () => {
  const src = await tmp("iris-sub-src-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-sub-out-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });

  // Parent: delegate once, then finish (the demo.ts shape).
  const parentModel = makeScriptedModel([
    { role: "assistant", content: "delegating", toolCalls: [{ callId: "a", name: "delegate", args: { task: "sub" } }], stopReason: "tool_use" },
    { role: "assistant", content: "parent-done", stopReason: "end_turn" },
  ]);

  // The child runs in its OWN durable session/store with a scripted reply.
  const childStore = new MemoryStateStore();
  const makeResolveChild = (_parentSessionId: string) => (): ResolvedChild => ({
    host: { name: "child", capabilities: { long_running: true }, store: childStore, scheduler: new MemoryScheduler() },
    defDigest: "child-def",
    program: harnessProgram({ messages: [{ role: "user", content: "sub-task" }] }),
    performers: {
      tactic: defaultBundle().tacticPerformer,
      model_call: makeScriptedModel([{ role: "assistant", content: "child-result", stopReason: "end_turn" }]),
    },
    clock: { now: () => 1 },
  });

  const store = new MemoryStateStore();
  const outcome = await cmdRun(out, {
    sessionId: "s",
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    modelPerformer: parentModel,
    subagents: { names: ["delegate"], makeResolveChild },
  });
  assert.equal(outcome.status, "finished", "parent turn finishes after the delegation returns");

  // The child ran in its own deterministic session.
  const childRows = await childStore.readJournal(childSessionId("s", "a"), 0);
  assert.ok(childRows.length > 0, "the child agent ran in its derived session");
});

test("cmdRun WITHOUT subagents: a `delegate` call is an ordinary tool (no subagent routing)", async () => {
  // Zero-value-off: with no subagents config, `delegate` is NOT a subagent tool, so the
  // kernel emits a normal tool_call (which, unregistered + non-safe, gates to ask → parks).
  const src = await tmp("iris-sub-off-src-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-sub-off-out-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });

  const model = makeScriptedModel([
    { role: "assistant", content: "x", toolCalls: [{ callId: "a", name: "delegate", args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ]);
  const outcome = await cmdRun(out, {
    sessionId: "s",
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    modelPerformer: model,
  });
  assert.equal(outcome.status, "parked", "no subagent routing → delegate is a normal (gated) tool call");
});

// review m4: the chat path (chatTurn) must thread subagents too, and stay byte-identical
// when unconfigured. chatTurn runs in interactive mode (parks on a user wait per turn).
function childResolver(childStore: MemoryStateStore): CliSubagents {
  return {
    names: ["delegate"],
    makeResolveChild: (_pid) => () => ({
      host: { name: "child", capabilities: { long_running: true }, store: childStore, scheduler: new MemoryScheduler() },
      defDigest: "child-def",
      program: harnessProgram({ messages: [{ role: "user", content: "sub-task" }] }),
      performers: {
        tactic: defaultBundle().tacticPerformer,
        model_call: makeScriptedModel([{ role: "assistant", content: "child-result", stopReason: "end_turn" }]),
      },
      clock: { now: () => 1 },
    }),
  };
}

const NO_INPUT: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {} };

test("chatTurn with subagents: a delegate call routes to the child; child runs in its session", async () => {
  const childStore = new MemoryStateStore();
  const deps: ChatDeps = {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "parent-def",
    // delegate must be in the bundle's safeTools so the gate auto-allows it.
    tacticPerformer: defaultBundle({ safeTools: ["delegate"] }).tacticPerformer,
    modelPerformer: makeScriptedModel([
      { role: "assistant", content: "delegating", toolCalls: [{ callId: "a", name: "delegate", args: { task: "sub" } }], stopReason: "tool_use" },
      { role: "assistant", content: "done", stopReason: "end_turn" },
    ]),
    sessionId: "chat-s",
    input: NO_INPUT,
    output: { write: () => {} },
    subagents: childResolver(childStore),
  };
  const outcome = await chatTurn(deps, "please delegate");
  assert.equal(outcome.status, "parked", "interactive chat parks on a user wait after the turn");
  const childRows = await childStore.readJournal(childSessionId("chat-s", "a"), 0);
  assert.ok(childRows.length > 0, "the delegated child ran in its derived session from chat");
});

test("chatTurn WITHOUT subagents: a normal message is a plain interactive turn (byte-identical)", async () => {
  const deps: ChatDeps = {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    defDigest: "parent-def",
    tacticPerformer: defaultBundle().tacticPerformer,
    modelPerformer: makeScriptedModel([{ role: "assistant", content: "hi", stopReason: "end_turn" }]),
    sessionId: "chat-s2",
    input: NO_INPUT,
    output: { write: () => {} },
  };
  const outcome = await chatTurn(deps, "hello");
  assert.equal(outcome.status, "parked", "no subagents → ordinary interactive turn, unchanged");
});
