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
} from "iris";
import { governingDigest, checkAgainstSchema, validateAgentfile } from "@iris/agent";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

// The scaffold now ships a bundled `now` tool, so building it needs the resolver
// loadBundledTools derives from the project's tools/ dir (not an empty resolver).
const scaffoldResolver = async (src: string) =>
  (await loadBundledTools(join(src, "tools"))).resolver;

test("T9 (9a): init scaffolds a self-contained project (agent + instructions + bundled tool)", async () => {
  const dir = await tmp("iris-init-");
  await cmdInit(dir);
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

test("T9 (9a): build → inspect → verify over a local OCI layout", async () => {
  const src = await tmp("iris-src-");
  await cmdInit(src);
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
  await cmdInit(src);
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
  await cmdInit(src);
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
