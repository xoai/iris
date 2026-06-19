// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_DEPLOY_SMOKE=1 node manual/iris-deploy-smoke.ts
//
// Proves `iris deploy`'s GENERATED worker.mjs actually boots the SAME @iris/core
// unchanged: scaffold the project, dynamically import the generated worker, and drive
// its AgentDO.fetch against an in-memory fake DurableObjectStorage (the install-free
// edge analogue — same approach as tests/store-do*.test.ts). Asserts a turn returns a
// valid status. This needs NO Cloudflare account and NO miniflare.
//
// The REAL edge deploy is the env-gated operator step (documented, not run here):
//   cd <outDir> && wrangler deploy        # bundles @iris/* (esbuild) + uploads to CF
//   wrangler secret put ANTHROPIC_API_KEY # for a real model (else the worker echoes)
// (A miniflare run of the bundled worker is the other manual option, cf.
//  manual/cloudflare-workers-smoke.ts.)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cmdInit, cmdBuild, cmdDeploy } from "@iris/cli";
import { makeLocalResolver } from "@iris/agent";

// A minimal in-memory DurableObjectStorage (the shape the generated doStorageAdapter
// wraps): Map-backed get/put/delete/list + a pass-through transaction + alarm hint.
function fakeDurableObjectStorage() {
  const map = new Map();
  let alarm = null;
  const api = {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async delete(key) { return map.delete(key); },
    async list(opts) {
      const out = new Map();
      for (const [k, v] of map) if (!opts || !opts.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      return out;
    },
    transaction(fn) { return fn(api); },
    async setAlarm(t) { alarm = t; },
    async getAlarm() { return alarm; },
  };
  return api;
}

async function main() {
  if (process.env.IRIS_DEPLOY_SMOKE !== "1") {
    console.log("skip: set IRIS_DEPLOY_SMOKE=1 to run the iris-deploy smoke (scaffold + boot the generated worker)");
    return;
  }
  const src = await mkdtemp(join(tmpdir(), "iris-deploy-src-"));
  await cmdInit(src);
  const oci = await mkdtemp(join(tmpdir(), "iris-deploy-oci-"));
  await cmdBuild({ file: join(src, "agent.json"), out: oci, resolver: makeLocalResolver({}) });

  // Generate UNDER the repo tree so the worker's bare `@iris/*` imports resolve via
  // Node's upward node_modules search (on a real deploy, wrangler/esbuild bundles them).
  const outDir = await mkdtemp(join(process.cwd(), ".iris-edge-smoke-"));
  try {
    const result = await cmdDeploy(oci, { outDir }); // scaffold-only (no opts.deploy)
    assert.deepEqual(result.files, ["wrangler.toml", "worker.mjs"]);
    console.log(result.plan);

    // Boot the GENERATED worker in Node and run a turn through AgentDO.fetch.
    const mod = await import(pathToFileURL(join(outDir, "worker.mjs")).href);
    const state = { storage: fakeDurableObjectStorage() };
    const ado = new mod.AgentDO(state, {}); // no ANTHROPIC_API_KEY → inline echo model
    const req = new Request("http://do/?session=smoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello edge" }] }),
    });
    const res = await ado.fetch(req);
    const out = await res.json();
    assert.ok(
      out.status === "finished" || out.status === "parked",
      `generated worker ran a valid edge turn, got ${JSON.stringify(out)}`,
    );
    console.log(`iris-deploy-smoke PASS — generated worker.mjs booted the core on a fake DO → ${JSON.stringify(out)}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("iris-deploy-smoke FAIL: " + (e && e.message ? e.message : e));
  process.exit(1);
});
