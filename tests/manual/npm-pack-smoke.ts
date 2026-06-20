// Manual smoke (heavy real-npm IO; OUTSIDE the test glob + tsc include, like the
// other tests/manual/* smokes). Proves the STRANGER FLOW end-to-end: build → pack the
// `npx iris-runtime` closure → install the tarballs into a clean dir OUTSIDE the repo →
// run the INSTALLED `iris` bin to scaffold + build a project. This exercises the
// compiled dist + the bin shebang + cross-package resolution exactly as a real
// `npm i -g iris-runtime` / `npx iris-runtime` user would.
// Run: IRIS_PACK_SMOKE=1 node tests/manual/npm-pack-smoke.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The transitive closure `npx iris-runtime` must install: iris-runtime + every
// publishable @irisrun/* workspace package it (transitively) depends on. Computed
// from the package.json graph so it can NEVER go stale as the CLI gains/loses deps
// (a hardcoded list silently 404s the moment a new dep lands — which it did).
const nameToDir: Record<string, string> = {};
for (const d of readdirSync(join(ROOT, "packages"))) {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, "packages", d, "package.json"), "utf8"));
    if (j.private !== true && typeof j.name === "string") nameToDir[j.name] = d;
  } catch { /* not a readable package — skip */ }
}
const CLOSURE: string[] = [];
const seen = new Set<string>();
const queue = ["iris-runtime"];
while (queue.length > 0) {
  const name = queue.shift() as string;
  if (seen.has(name) || !nameToDir[name]) continue; // private/non-workspace dep → not packed
  seen.add(name);
  CLOSURE.push(name);
  const deps = JSON.parse(readFileSync(join(ROOT, "packages", nameToDir[name], "package.json"), "utf8")).dependencies ?? {};
  for (const dep of Object.keys(deps)) if (nameToDir[dep]) queue.push(dep);
}

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
    execFileSync("tar", ["-xzf", join(packDir, "iris-runtime-0.1.0.tgz"), "-C", packDir], { stdio: "ignore" });
    const pkgJson = JSON.parse(await readFile(join(packDir, "package", "package.json"), "utf8"));
    assert.deepEqual(pkgJson.bin, { iris: "dist/cli-main.js" }, "bin → dist (no leading ./ — npm normalizes it away on publish)");
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

    console.log("npm-pack smoke PASS — built dist, packed the closure, installed it in a clean dir, and ran the INSTALLED `iris` bin to scaffold + build a project. `npx iris-runtime init` works.");
  } finally {
    if (existsSync(packDir)) await rm(packDir, { recursive: true, force: true });
    if (existsSync(proj)) await rm(proj, { recursive: true, force: true });
  }
}

await main();
