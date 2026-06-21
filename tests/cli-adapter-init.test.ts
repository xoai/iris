// `iris adapter init <kind> <name> [dir]` (packages/cli/src/adapter-init.ts) — scaffolds a
// buildable, conformance-wired adapter package. We assert the files for every kind, RUN the
// store scaffold's conformance suite green end-to-end (spawn), and pin the loud refusals
// (unknown kind, no-clobber).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdAdapterInit } from "../packages/cli/src/adapter-init.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("adapter init: each kind scaffolds the expected wired files", async () => {
  const tmp = mkdtempSync(join(repoRoot, ".adapter-init-"));
  try {
    for (const kind of ["store", "channel", "provider"] as const) {
      const { dir, files } = await cmdAdapterInit(kind, `demo-${kind}`, tmp);
      assert.deepEqual(
        [...files].sort(),
        ["README.md", "package.json", "src/index.ts", "tsconfig.json", `test/demo-${kind}.test.ts`].sort(),
      );
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        dependencies: Record<string, string>;
      };
      assert.equal(pkg.name, `demo-${kind}`);
      assert.ok(pkg.dependencies["@irisrun/sdk"], "the scaffold depends on @irisrun/sdk");
      const src = readFileSync(join(dir, "src", "index.ts"), "utf8");
      const factory = kind === "store" ? "openStore" : kind === "channel" ? "openChannel" : "openModelProvider";
      assert.match(src, new RegExp(`export const ${factory}`), `src exports the ${factory} loader entry`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapter init: the STORE scaffold passes its conformance suite green (end-to-end)", async () => {
  const tmp = mkdtempSync(join(repoRoot, ".adapter-init-store-"));
  try {
    const { dir } = await cmdAdapterInit("store", "demo-store", tmp);
    // Run the scaffolded conformance test directly; @irisrun/sdk resolves to the workspace
    // src via the iris-src condition (the temp dir is under the repo so node walks up to its
    // node_modules). A real author runs `npm install && npm test`.
    // Strip NODE_TEST_CONTEXT: this test itself runs under `node --test`, which would make
    // the CHILD node:test report via IPC (empty stdout) instead of printing TAP.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "--conditions=iris-src" };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", join(dir, "test", "demo-store.test.ts")], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `scaffolded store conformance must pass green:\n${out}`);
    assert.match(out, /pass [1-9]\d*/, `expected passing conformance cases, got:\n${out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapter init: an unknown kind is refused loudly", async () => {
  await assert.rejects(cmdAdapterInit("widget", "x", "."), /unknown kind/);
});

test("adapter init: an existing non-empty target is refused (no-clobber)", async () => {
  const tmp = mkdtempSync(join(repoRoot, ".adapter-init-clobber-"));
  try {
    await cmdAdapterInit("store", "demo-store", tmp);
    await assert.rejects(cmdAdapterInit("store", "demo-store", tmp), /no-clobber|already exists/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
