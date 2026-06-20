// the batteries-included starter tool. Covers `loadBundledTools` (the
// tools/*.tool.json discovery that feeds the build resolver + the run/chat/serve
// subprocess transport), the SCAFFOLDED now.mjs over the REAL subprocess
// transport, a tool-less regression, and a full harness turn where a scripted
// model emits a tool_call for the bundled tool (journaled + replays).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundledTools, cmdInit, cmdBuild, cmdRun, resolveToolEnvForImage, secretFileEnv } from "iris-runtime";
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
  await cmdInit(project, { json: true });
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
  await cmdInit(project, { json: true });
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
  await cmdInit(project, { json: true });
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

// --- A4: scoped tool env (initiative 20260620-agentfile-env-secrets) -----------

const ENVCHECK_DESCRIPTOR = {
  ref: "subprocess://envcheck",
  name: "envcheck",
  description: "Return this tool's own environment variable NAMES (never values).",
  inputSchema: { type: "object", properties: {} },
  retrySafe: true,
  exec: "envcheck.mjs",
};
// Echoes its env KEYS only (never values) so the journal stays secret-free.
const ENVCHECK_JS = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, value: { keys: Object.keys(process.env).sort() } }) + "\\n");
  process.exit(0);
});
`;

test("A4: a scoped tool sees ONLY declared env (least-privilege); no host leak; no secret value journaled", async () => {
  const root = await tmp("iris-a4-");
  const src = join(root, "proj");
  const toolsDir = join(src, "tools");
  await mkdir(toolsDir, { recursive: true });
  const agent = {
    apiVersion: "iris/v1", kind: "Agent", name: "envy", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [],
    tools: [{ ref: "subprocess://envcheck" }], connections: [],
    harness: { bundle: "default" },
    requires: { local_subprocess: true, tool_locality: "local" },
    sandbox: { backend: "inmemory", network: "deny-all" },
    secrets: ["GITHUB_TOKEN"], environment: { LOG_LEVEL: "info" },
  };
  await writeFile(join(src, "agent.json"), JSON.stringify(agent, null, 2));
  await writeFile(join(src, "instructions.md"), "# Instructions\n");
  await writeFile(join(toolsDir, "envcheck.tool.json"), JSON.stringify(ENVCHECK_DESCRIPTOR));
  await writeFile(join(toolsDir, "envcheck.mjs"), ENVCHECK_JS);

  const bundled = await loadBundledTools(toolsDir);
  const out = join(root, "out");
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver: bundled.resolver });
  assert.deepEqual(image.agentfile.secrets, ["GITHUB_TOKEN"]);

  // Resolve the scoped env via the SAME tested seam the CLI uses.
  const SECRET_VALUE = "ghp_do_not_journal";
  const env = resolveToolEnvForImage({
    secrets: image.agentfile.secrets,
    environment: image.agentfile.environment,
    platform: process.platform,
    hostEnv: { ...process.env, GITHUB_TOKEN: SECRET_VALUE, IRIS_A4_LEAK: "leak" } as Record<string, string>,
    envFiles: [],
    envInline: [],
    command: "iris run",
  });
  assert.ok(env, "scoped env resolved");
  assert.equal(env.GITHUB_TOKEN, SECRET_VALUE);
  assert.equal(env.LOG_LEVEL, "info");
  assert.ok(!("IRIS_A4_LEAK" in env), "an undeclared host var is not in the scoped env");

  const store = new MemoryStateStore();
  const model = makeScriptedModel([
    { role: "assistant", content: "checking env", toolCalls: [{ callId: "c1", name: "envcheck", args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ]);
  const t = await cmdRun(out, {
    sessionId: "s", store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    modelPerformer: model,
    toolInvoker: makeToolInvoker({ subprocess: makeSubprocessTransport(bundled.subprocessSpecs, { env }) }),
    safeTools: bundled.safeToolNames,
  });
  assert.equal(t.status, "finished");

  const rows = await store.readJournal("s", 0);
  const journalText = rows.map((r) => JSON.stringify(decode(r.bytes))).join("\n");
  assert.match(journalText, /"GITHUB_TOKEN"/, "the declared secret NAME reached the tool's env");
  assert.match(journalText, /"LOG_LEVEL"/, "the environment literal reached the tool");
  assert.ok(!journalText.includes("IRIS_A4_LEAK"), "an undeclared host var did NOT reach the tool");
  assert.ok(!journalText.includes(SECRET_VALUE), "the secret VALUE is never journaled (only names are echoed)");
});

// --- A5: file-mount secrets (Docker "Very Low" tier) ---------------------------

const SECRETCHECK_DESCRIPTOR = {
  ref: "subprocess://secretcheck",
  name: "secretcheck",
  description: "Report whether the secret arrived as a FILE ref (never echoes the value).",
  inputSchema: { type: "object", properties: {} },
  retrySafe: true,
  exec: "secretcheck.mjs",
};
// Reports the file-ref presence + that the secret is ABSENT from env. Never echoes
// the value (it doesn't even read the file) → the journal stays secret-free.
const SECRETCHECK_JS = `
import { existsSync } from "node:fs";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  const ref = process.env.GITHUB_TOKEN_FILE;
  const value = {
    fileRefPresent: typeof ref === "string" && ref.length > 0,
    fileExists: typeof ref === "string" ? existsSync(ref) : false,
    tokenInEnv: process.env.GITHUB_TOKEN === undefined ? "absent" : "present",
  };
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, value }) + "\\n");
  process.exit(0);
});
`;

test("A5: --secret-files delivers the secret as a 0600 FILE (value NOT in env, not journaled)", async () => {
  const root = await tmp("iris-a5-");
  const src = join(root, "proj");
  const toolsDir = join(src, "tools");
  await mkdir(toolsDir, { recursive: true });
  const agent = {
    apiVersion: "iris/v1", kind: "Agent", name: "filey", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [],
    tools: [{ ref: "subprocess://secretcheck" }], connections: [],
    harness: { bundle: "default" },
    requires: { local_subprocess: true, tool_locality: "local" },
    sandbox: { backend: "inmemory", network: "deny-all" },
    secrets: ["GITHUB_TOKEN"],
  };
  await writeFile(join(src, "agent.json"), JSON.stringify(agent, null, 2));
  await writeFile(join(src, "instructions.md"), "# Instructions\n");
  await writeFile(join(toolsDir, "secretcheck.tool.json"), JSON.stringify(SECRETCHECK_DESCRIPTOR));
  await writeFile(join(toolsDir, "secretcheck.mjs"), SECRETCHECK_JS);

  const bundled = await loadBundledTools(toolsDir);
  const out = join(root, "out");
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver: bundled.resolver });

  // Resolve the scoped env, then convert secrets to FILE mode (the same seams the CLI uses).
  const SECRET_VALUE = "ghp_file_only_secret";
  const scoped = resolveToolEnvForImage({
    secrets: image.agentfile.secrets,
    platform: process.platform,
    hostEnv: { ...process.env, GITHUB_TOKEN: SECRET_VALUE } as Record<string, string>,
    envFiles: [],
    envInline: [],
    command: "iris run",
  });
  assert.ok(scoped, "scoped env resolved");
  const secretsDir = await mkdtemp(join(tmpdir(), "iris-a5-secrets-"));
  const { env, files } = secretFileEnv(scoped, ["GITHUB_TOKEN"], secretsDir);
  for (const f of files) await writeFile(f.path, f.value, { mode: 0o600 });
  assert.ok(!("GITHUB_TOKEN" in env), "the secret VALUE is NOT in the env");
  assert.equal(env.GITHUB_TOKEN_FILE, join(secretsDir, "GITHUB_TOKEN"));

  const store = new MemoryStateStore();
  const model = makeScriptedModel([
    { role: "assistant", content: "checking", toolCalls: [{ callId: "c1", name: "secretcheck", args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ]);
  const t = await cmdRun(out, {
    sessionId: "s", store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    modelPerformer: model,
    toolInvoker: makeToolInvoker({ subprocess: makeSubprocessTransport(bundled.subprocessSpecs, { env }) }),
    safeTools: bundled.safeToolNames,
  });
  assert.equal(t.status, "finished");

  const rows = await store.readJournal("s", 0);
  const journalText = rows.map((r) => JSON.stringify(decode(r.bytes))).join("\n");
  assert.match(journalText, /"fileRefPresent":true/, "the tool received GITHUB_TOKEN_FILE");
  assert.match(journalText, /"fileExists":true/, "the 0600 secret file exists for the tool to read");
  assert.match(journalText, /"tokenInEnv":"absent"/, "the secret VALUE is absent from the tool's env");
  assert.ok(!journalText.includes(SECRET_VALUE), "the secret VALUE is never journaled");
});
