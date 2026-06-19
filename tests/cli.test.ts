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
} from "@iris/cli";
import { makeLocalResolver, governingDigest } from "@iris/agent";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

test("T9 (9a): init scaffolds an agent.json + instructions.md", async () => {
  const dir = await tmp("iris-init-");
  await cmdInit(dir);
  const agent = JSON.parse(await readFile(join(dir, "agent.json"), "utf8"));
  assert.equal(agent.apiVersion, "iris/v1");
  assert.equal((await readFile(join(dir, "instructions.md"), "utf8")).length > 0, true);
});

test("T9 (9a): build → inspect → verify over a local OCI layout", async () => {
  const src = await tmp("iris-src-");
  await cmdInit(src);
  const out = await tmp("iris-out-");
  const resolver = makeLocalResolver({});
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  assert.match(image.lock.imageDigest, /^[0-9a-f]{64}$/);
  const info = await cmdInspect(out);
  assert.equal(info.name, "my-agent");
  assert.equal(info.imageDigest, image.lock.imageDigest);
  await cmdVerify(out, { resolver }); // must not throw
});

test("T9 (9b): push/pull round-trip a local OCI layout dir", async () => {
  const src = await tmp("iris-s-");
  await cmdInit(src);
  const out = await tmp("iris-o-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: makeLocalResolver({}) });
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
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver: makeLocalResolver({}) });
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
