// T9 — the iris CLI command functions, install-free (injected deps; no registry,
// no real model, no Docker). Covers 9a (init/build/inspect/verify), 9b (push/pull
// over a local OCI layout), and 9c (run against an in-memory host + a fake model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdInit,
  cmdBuild,
  cmdInspect,
  cmdVerify,
  cmdPush,
  cmdPull,
  cmdRun,
  loadBundledTools,
  resolveBuildFile,
} from "iris-runtime";
import { governingDigest, checkAgainstSchema, validateAgentfile, parseAgentfileYaml, parseYamlValue } from "@irisrun/agent";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

// The scaffold now ships a bundled `now` tool, so building it needs the resolver
// loadBundledTools derives from the project's tools/ dir (not an empty resolver).
const scaffoldResolver = async (src: string) =>
  (await loadBundledTools(join(src, "tools"))).resolver;

test("T9 (9a): init --json scaffolds a self-contained project (agent + instructions + bundled tool)", async () => {
  const dir = await tmp("iris-init-");
  await cmdInit(dir, { json: true });
  const agent = JSON.parse(await readFile(join(dir, "agent.json"), "utf8"));
  assert.equal(agent.apiVersion, "iris/v1");
  assert.equal(agent.tools[0].ref, "subprocess://now", "scaffold references the bundled tool");
  assert.equal(agent.requires.local_subprocess, true, "subprocess tool requires local_subprocess");
  assert.equal((await readFile(join(dir, "instructions.md"), "utf8")).length > 0, true);
  // the bundled tool ships: a runnable script + its descriptor
  assert.ok((await readFile(join(dir, "tools", "now.mjs"), "utf8")).includes("process.stdin"));
  const desc = JSON.parse(await readFile(join(dir, "tools", "now.tool.json"), "utf8"));
  assert.equal(desc.ref, "subprocess://now");
  assert.equal(desc.exec, "now.mjs");
  // The REAL emitted scaffold validates against BOTH the published JSON schema
  // and the runtime validator (initiative 20260620-agentfile-schema) — this pins
  // the actual `iris init` output, not a drift-prone copy of SCAFFOLD_AGENT.
  assert.deepEqual(checkAgainstSchema(agent), [], "scaffolded agent.json passes the published schema");
  assert.doesNotThrow(() => validateAgentfile(agent), "scaffolded agent.json passes the runtime validator");
});

test("T9 (9a): init (DEFAULT) scaffolds agent.yaml that validates, builds, and matches the JSON scaffold", async () => {
  const yamlDir = await tmp("iris-inity-");
  await cmdInit(yamlDir); // default is YAML now
  const yamlText = await readFile(join(yamlDir, "agent.yaml"), "utf8");
  await assert.rejects(readFile(join(yamlDir, "agent.json"), "utf8"), "no agent.json written by default");

  const yModel = parseAgentfileYaml(yamlText);
  assert.equal(yModel.tools[0].ref, "subprocess://now");
  assert.deepEqual(yModel.skills, [], "empty skills authored via the [] literal");
  assert.deepEqual(yModel.connections, []);
  assert.ok(!("secrets" in yModel), "scaffold ships secrets COMMENTED (default agent stays legacy)");
  assert.ok(!("environment" in yModel), "scaffold ships environment COMMENTED");
  assert.deepEqual(checkAgainstSchema(parseYamlValue(yamlText)), [], "yaml scaffold passes the published schema");

  // Same model as the JSON scaffold (round-trip parity).
  const jsonDir = await tmp("iris-initj-");
  await cmdInit(jsonDir, { json: true });
  const jModel = validateAgentfile(JSON.parse(await readFile(join(jsonDir, "agent.json"), "utf8")));
  assert.deepEqual(yModel, jModel, "yaml scaffold parses to the SAME model as the json scaffold");

  // It builds.
  const out = await tmp("iris-inity-out-");
  const image = await cmdBuild({ file: join(yamlDir, "agent.yaml"), out, resolver: await scaffoldResolver(yamlDir) });
  assert.match(image.lock.imageDigest, /^[0-9a-f]{64}$/);
});

test("T9 (9a): resolveBuildFile auto-detects the default Agentfile (warns on ambiguity)", () => {
  const set = (...names: string[]) => ({ exists: (p: string) => names.some((n) => p.endsWith(n)) });
  assert.equal(resolveBuildFile("/p", set("agent.json")).file, join("/p", "agent.json"));
  assert.equal(resolveBuildFile("/p", set("agent.yaml")).file, join("/p", "agent.yaml"));
  assert.equal(resolveBuildFile("/p", set("agent.yml")).file, join("/p", "agent.yml"));
  const both = resolveBuildFile("/p", set("agent.json", "agent.yaml"));
  assert.equal(both.file, join("/p", "agent.json"), "json wins when several exist");
  assert.match(both.warning ?? "", /multiple Agentfiles/);
  const none = resolveBuildFile("/p", { exists: () => false });
  assert.equal(none.file, join("/p", "agent.json"), "none exist → agent.json default");
  assert.equal(none.warning, undefined);
});

test("T9 (9a): build → inspect → verify over a local OCI layout", async () => {
  const src = await tmp("iris-src-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-out-");
  const resolver = await scaffoldResolver(src);
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  assert.match(image.lock.imageDigest, /^[0-9a-f]{64}$/);
  const info = await cmdInspect(out);
  assert.equal(info.name, "my-agent");
  assert.equal(info.imageDigest, image.lock.imageDigest);
  assert.equal(info.tools[0].transport, "subprocess", "the bundled tool pins as a subprocess contract");
  await cmdVerify(out, { resolver }); // must not throw (re-resolves the ref by the same resolver)
});

test("T9 (9b): push/pull round-trip a local OCI layout dir", async () => {
  const src = await tmp("iris-s-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-o-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });
  const registry = join(await tmp("iris-reg-"), "img");
  await cmdPush(out, registry);
  const pulledRoot = await tmp("iris-pull-");
  const pulled = join(pulledRoot, "img");
  await cmdPull(registry, pulled);
  const info = await cmdInspect(pulled);
  assert.equal(info.name, "my-agent");
});

test("T9 (9c): run drives a turn against an in-memory host with a fake model; pins the layout digest", async () => {
  const src = await tmp("iris-rs-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-ro-");
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });
  const store = new MemoryStateStore();
  const t = await cmdRun(out, {
    sessionId: "s",
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    modelPerformer: makeScriptedModel([{ role: "assistant", content: "done", stopReason: "end_turn" }]),
  });
  assert.equal(t.status, "finished");
  assert.equal(await governingDigest(store, "s"), image.lock.imageDigest, "new session pinned to the layout digest");
});
