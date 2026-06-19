// Manual smoke (heavy real-npm IO; OUTSIDE the test glob + tsc include, like the
// other manual/* smokes). Proves the STRANGER FLOW end-to-end: build → pack the
// `npx iris` closure → install the tarballs into a clean dir OUTSIDE the repo →
// run the INSTALLED `iris` bin to scaffold + build a project. This exercises the
// compiled dist + the bin shebang + cross-package resolution exactly as a real
// `npm i -g iris` / `npx iris` user would.
// Run: IRIS_PACK_SMOKE=1 node manual/npm-pack-smoke.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The transitive closure `npx iris` must install (iris + its @iris/* deps).
const CLOSURE = [
  "iris",
  "@iris/core",
  "@iris/tools",
  "@iris/agent",
  "@iris/host",
  "@iris/channel-rest",
  "@iris/channel-web",
  "@iris/store-do",
  "@iris/store-sqlite",
  "@iris/provider-anthropic",
];

async function main(): Promise<void> {
  if (process.env.IRIS_PACK_SMOKE !== "1") {
    console.log("skip: set IRIS_PACK_SMOKE=1 to run the npm-pack smoke");
    return;
  }
  const packDir = await mkdtemp(join(tmpdir(), "iris-pack-"));
  const proj = await mkdtemp(join(tmpdir(), "iris-pack-proj-"));
  try {
    // 1. Compile to dist (files:["dist"] → the tarballs ship compiled JS).
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });

    // 2. Pack the whole closure.
    for (const pkg of CLOSURE) {
      execFileSync("npm", ["pack", "--workspace", pkg, "--pack-destination", packDir], { cwd: ROOT, stdio: "ignore" });
    }
    const tarballs = (await readdir(packDir)).filter((f) => f.endsWith(".tgz"));
    assert.equal(tarballs.length, CLOSURE.length, `packed ${CLOSURE.length} closure tarballs`);

    // 3. The `iris` tarball ships compiled dist (not src), bin → dist, shebang intact.
    execFileSync("tar", ["-xzf", join(packDir, "iris-0.1.0.tgz"), "-C", packDir], { stdio: "ignore" });
    const pkgJson = JSON.parse(await readFile(join(packDir, "package", "package.json"), "utf8"));
    assert.deepEqual(pkgJson.bin, { iris: "./dist/cli-main.js" }, "bin → dist");
    assert.ok(existsSync(join(packDir, "package", "dist", "cli-main.js")), "dist/cli-main.js shipped");
    assert.ok(!existsSync(join(packDir, "package", "src")), "src NOT shipped (dist only)");
    const binSrc = await readFile(join(packDir, "package", "dist", "cli-main.js"), "utf8");
    assert.ok(binSrc.startsWith("#!/usr/bin/env node"), "compiled bin keeps the node shebang");

    // 4. Install the FULL closure into a clean project OUTSIDE the repo, exactly
    //    like a stranger. `^0.1.0` inter-deps resolve against the sibling tarballs.
    await writeFile(join(proj, "package.json"), JSON.stringify({ name: "stranger", private: true, type: "module" }));
    const tgzPaths = tarballs.map((t) => join(packDir, t));
    execFileSync("npm", ["install", ...tgzPaths, "--no-audit", "--no-fund"], { cwd: proj, stdio: "ignore" });
    const binPath = join(proj, "node_modules", ".bin", "iris");
    assert.ok(existsSync(binPath), "npm linked the iris bin shim");

    // 5. Run the INSTALLED bin (compiled dist, via the shebang) to scaffold a project.
    const agentDir = join(proj, "my-agent");
    execFileSync(binPath, ["init", agentDir], { cwd: proj, stdio: "ignore" });
    assert.ok(existsSync(join(agentDir, "agent.json")), "iris init scaffolded agent.json");
    assert.ok(existsSync(join(agentDir, "tools", "now.mjs")), "iris init scaffolded the bundled tool");

    // 6. Build the scaffolded image with the installed bin (resolver from ./tools).
    execFileSync(binPath, ["build", "--file", "agent.json", "--out", "image"], { cwd: agentDir, stdio: "ignore" });
    assert.ok(existsSync(join(agentDir, "image", "index.json")), "iris build produced an OCI layout");

    console.log("npm-pack smoke PASS — built dist, packed the closure, installed it in a clean dir, and ran the INSTALLED `iris` bin to scaffold + build a project. `npx iris init` works.");
  } finally {
    if (existsSync(packDir)) await rm(packDir, { recursive: true, force: true });
    if (existsSync(proj)) await rm(proj, { recursive: true, force: true });
  }
}

await main();
