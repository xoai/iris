// P0 #2 — the batteries-included starter tool. Covers `loadBundledTools` (the
// tools/*.tool.json discovery that feeds the build resolver + the run/chat/serve
// subprocess transport), the SCAFFOLDED now.mjs over the REAL subprocess
// transport, a tool-less regression, and a full harness turn where a scripted
// model emits a tool_call for the bundled tool (journaled + replays).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundledTools, cmdInit, cmdBuild, cmdRun } from "iris-runtime";
import { makeSubprocessTransport, makeToolInvoker } from "@irisrun/tools";
import { decode } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

// Write a tools/ dir with the given {filename → descriptor object} and any extra
// script files {filename → contents}. Returns the toolsDir path.
async function makeToolsDir(
  descriptors: Record<string, unknown>,
  scripts: Record<string, string> = {},
): Promise<string> {
  const root = await tmp("iris-tools-");
  const dir = join(root, "tools");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(descriptors)) {
    await writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const NOW_DESCRIPTOR = {
  ref: "subprocess://now",
  name: "now",
  description: "Return the current date and time.",
  inputSchema: { type: "object", properties: {} },
  retrySafe: true,
  exec: "now.mjs",
};

// --- A1: loadBundledTools ------------------------------------------------------

test("A1: loadBundledTools resolves a subprocess descriptor → contract + spec", async () => {
  const dir = await makeToolsDir({ "now.tool.json": NOW_DESCRIPTOR }, { "now.mjs": "" });
  const bundled = await loadBundledTools(dir);

  const contract = await bundled.resolver.resolve("subprocess://now");
  assert.ok(contract, "ref must resolve");
  assert.equal(contract.transport, "subprocess");
  assert.equal(contract.location, "subprocess://now");
  assert.equal(contract.name, "now");
  assert.equal(contract.retrySafe, true);

  // Spec keyed by the location handle ("now"); exec resolved to an ABSOLUTE path.
  const spec = bundled.subprocessSpecs["now"];
  assert.ok(spec, "spec keyed by handle");
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args?.length, 1);
  assert.equal(spec.args?.[0], join(dir, "now.mjs"));
  assert.equal(bundled.contracts.length, 1);
});

test("A1: loadBundledTools on a missing dir → empty (tool-less stays valid)", async () => {
  const root = await tmp("iris-empty-");
  const bundled = await loadBundledTools(join(root, "tools")); // does not exist
  assert.equal(await bundled.resolver.resolve("subprocess://now"), null);
  assert.deepEqual(bundled.subprocessSpecs, {});
  assert.deepEqual(bundled.contracts, []);
});

test("A1: loadBundledTools rejects malformed JSON (names the file)", async () => {
  const dir = await makeToolsDir({ "bad.tool.json": "{ not json" });
  await assert.rejects(loadBundledTools(dir), /bad\.tool\.json/);
});

test("A1: loadBundledTools rejects a missing required field", async () => {
  const { name: _omit, ...noName } = NOW_DESCRIPTOR;
  const dir = await makeToolsDir({ "now.tool.json": noName });
  await assert.rejects(loadBundledTools(dir), /name/);
});

test("A1: loadBundledTools rejects a non-subprocess ref", async () => {
  const dir = await makeToolsDir({ "x.tool.json": { ...NOW_DESCRIPTOR, ref: "mcp://r/x" } });
  await assert.rejects(loadBundledTools(dir), /subprocess/);
});

test("A1: loadBundledTools rejects a duplicate ref across files", async () => {
  const dir = await makeToolsDir({
    "a.tool.json": NOW_DESCRIPTOR,
    "b.tool.json": { ...NOW_DESCRIPTOR, name: "now2" }, // same ref, different name
  });
  await assert.rejects(loadBundledTools(dir), /subprocess:\/\/now/);
});

test("A1: loadBundledTools rejects a duplicate tool name across files", async () => {
  const dir = await makeToolsDir({
    "a.tool.json": NOW_DESCRIPTOR,
    "b.tool.json": { ...NOW_DESCRIPTOR, ref: "subprocess://now2" }, // same name, different ref
  });
  await assert.rejects(loadBundledTools(dir), /name/);
});

test("A1: loadBundledTools rejects an exec that escapes the tools dir", async () => {
  const esc = await makeToolsDir({ "e.tool.json": { ...NOW_DESCRIPTOR, exec: "../evil.mjs" } });
  await assert.rejects(loadBundledTools(esc), /exec/);
  const abs = await makeToolsDir({ "a.tool.json": { ...NOW_DESCRIPTOR, exec: "/etc/passwd" } });
  await assert.rejects(loadBundledTools(abs), /exec/);
});

// --- A2: the SCAFFOLDED now.mjs over the REAL subprocess transport -------------

test("A2: the scaffolded now.mjs returns a well-formed time over the real subprocess transport", async () => {
  const project = await tmp("iris-scaffold-");
  await cmdInit(project);
  const bundled = await loadBundledTools(join(project, "tools"));
  const transport = makeSubprocessTransport(bundled.subprocessSpecs);
  const contract = (await bundled.resolver.resolve("subprocess://now"))!;

  const ok = await transport.invoke(contract, { tz: "UTC" }, "idem-1");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    const v = ok.value as { iso: string; unixMs: number; tz: string };
    assert.match(v.iso, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp");
    assert.equal(typeof v.unixMs, "number");
    assert.equal(v.tz, "UTC");
  }
});

test("A2: the scaffolded now.mjs fails cleanly on an invalid timezone (bad_tz)", async () => {
  const project = await tmp("iris-scaffold-tz-");
  await cmdInit(project);
  const bundled = await loadBundledTools(join(project, "tools"));
  const transport = makeSubprocessTransport(bundled.subprocessSpecs);
  const contract = (await bundled.resolver.resolve("subprocess://now"))!;

  const bad = await transport.invoke(contract, { tz: "Mars/Olympus_Mons" }, "idem-2");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "bad_tz");
});

test("A2: a tool-less agent builds via the loadBundledTools resolver (regression)", async () => {
  // A hand-written tool-less agent.json (no tools/ dir): the loadBundledTools
  // resolver is an empty no-op, exactly like the old empty-resolver path.
  const root = await tmp("iris-toolless-");
  const src = join(root, "proj");
  await mkdir(src, { recursive: true });
  const agent = {
    apiVersion: "iris/v1",
    kind: "Agent",
    name: "bare",
    model: "anthropic/claude-x",
    instructions: "./instructions.md",
    skills: [],
    tools: [],
    connections: [],
    harness: { bundle: "default" },
    requires: { tool_locality: "remote" },
    sandbox: { backend: "inmemory", network: "deny-all" },
  };
  await writeFile(join(src, "agent.json"), JSON.stringify(agent, null, 2));
  await writeFile(join(src, "instructions.md"), "# Instructions\n");
  const resolver = (await loadBundledTools(join(src, "tools"))).resolver; // tools/ absent → empty
  const out = join(root, "out");
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  assert.equal(image.lock.tools.length, 0, "tool-less image has no tools");
});

// --- A3: cmdRun wires the bundled tool end-to-end (model → subprocess → journal) -

test("A3: cmdRun wires the bundled tool — a model tool_call runs via subprocess, journaled + replay-stable", async () => {
  const project = await tmp("iris-a3-");
  await cmdInit(project);
  const out = await tmp("iris-a3-out-");
  const bundled = await loadBundledTools(join(project, "tools"));
  await cmdBuild({ file: join(project, "agent.json"), out, resolver: bundled.resolver });

  // `now` is retrySafe → surfaced in safeToolNames → auto-allowed (no approval park)
  assert.deepEqual(bundled.safeToolNames, ["now"]);

  const store = new MemoryStateStore();
  const model = makeScriptedModel([
    { role: "assistant", content: "checking the clock", toolCalls: [{ callId: "c1", name: "now", args: { tz: "UTC" } }], stopReason: "tool_use" },
    { role: "assistant", content: "the time is recorded", stopReason: "end_turn" },
  ]);

  // assertReplay:true inside cmdRun proves the journaled tool result replays
  // deterministically (reducer-only, no re-spawn); a throw would fail the turn.
  const t = await cmdRun(out, {
    sessionId: "s",
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    modelPerformer: model,
    toolInvoker: makeToolInvoker({ subprocess: makeSubprocessTransport(bundled.subprocessSpecs) }),
    safeTools: bundled.safeToolNames,
  });
  assert.equal(t.status, "finished", "the tool auto-allowed (safeTools) and the turn finished");

  // the subprocess tool actually ran: its value (unixMs) is in the journal
  const rows = await store.readJournal("s", 0);
  const journalText = rows.map((r) => JSON.stringify(decode(r.bytes))).join("\n");
  assert.match(journalText, /"unixMs"/, "the bundled tool's result is journaled");
});
