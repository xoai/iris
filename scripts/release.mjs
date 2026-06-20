#!/usr/bin/env node
// Gated npm publish for the Iris monorepo. Mirrors the repo's egress-gating
// convention: push/pull operate on a local OCI layout, `iris deploy --deploy`
// needs IRIS_DEPLOY=1, and a real `npm publish` needs IRIS_PUBLISH=1.
//
// HARD PREREQUISITE (do not remove): the packages ship raw .ts source in dev
// (the "no build step" dev model). Node REFUSES to type-strip .ts files once
// they live under an installed node_modules tree
//   "Stripping types is currently unsupported for files under node_modules"
// so a published .ts-source package would fail to import for any consumer. The
// compile-to-JS publish build (src → dist/*.js + *.d.ts, with exports/bin/files
// pointed at ./dist) IS IMPLEMENTED (`npm run build` / scripts/build.mjs) and
// this script ALWAYS runs it first (see below). The dist-existence check is a
// safety net — it REFUSES to publish if any package is missing its build output,
// so it can never push broken packages.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function npm(args) {
  const r = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// Always compile to JS first — `npm publish`/`pack` ship dist, and Node won't
// type-strip .ts under node_modules, so an uncompiled publish is broken.
console.log("iris release: building packages (src → dist)…");
{
  const b = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (b.status !== 0) {
    console.error("iris release: build failed — refusing to publish.");
    process.exit(1);
  }
}

if (dryRun) {
  // `npm pack --dry-run` lists each publishable workspace's tarball contents
  // without creating files or contacting the registry — a clean "what would ship".
  console.log("\niris release: dry-run — listing tarball contents for the publishable workspaces\n");
  npm(["pack", "--workspaces", "--dry-run"]);
}

if (process.env.IRIS_PUBLISH !== "1") {
  console.error(
    "iris release: refusing to publish without IRIS_PUBLISH=1.\n" +
      "  Real npm egress is gated (cf. IRIS_DEPLOY=1 for `iris deploy`).\n" +
      "  Run `npm run release:dry` to preview the tarballs.",
  );
  process.exit(1);
}

// Compile-to-JS prerequisite: `npm publish --workspaces` ships EVERY publishable
// package, so EACH must have a dist/ build — not just the CLI. Refuse unless all
// are compiled (an uncompiled .ts package fails to import once installed under
// node_modules). Enumerate the publishable workspaces (packages/* without
// private:true) and check each.
const pkgsDir = join(root, "packages");
const uncompiled = readdirSync(pkgsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => {
    try {
      return JSON.parse(readFileSync(join(pkgsDir, d.name, "package.json"), "utf8")).private !== true;
    } catch {
      return false; // no/unreadable package.json → not a publishable workspace
    }
  })
  .filter((d) => !existsSync(join(pkgsDir, d.name, "dist")))
  .map((d) => d.name)
  .sort();

if (uncompiled.length > 0) {
  console.error(
    "iris release: BLOCKED — these publishable packages are not compiled to JavaScript:\n" +
      `  ${uncompiled.join(", ")}\n` +
      "  Node will not type-strip the shipped .ts source once installed under node_modules,\n" +
      "  so publishing now would push packages that fail to import. Add the compile-to-JS\n" +
      "  publish build first (src → dist; point exports/bin/files at ./dist). See RELEASING.md.",
  );
  process.exit(1);
}

// Publish per package, idempotently. `npm publish --workspaces` republishes the
// whole set in one shot and ERRORS on any version that is already live — so a
// single rate-limit (npm E429) mid-run leaves a PARTIAL release that no re-run
// can finish (the first already-live package aborts the batch). Instead: skip
// packages already on the registry at this version, publish only the missing
// ones, and back off on the transient rate-limit. This makes a re-pushed tag
// genuinely complete a partial release, which is the idempotency the workflow
// has always advertised.
const publishable = readdirSync(pkgsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    try {
      const pj = JSON.parse(readFileSync(join(pkgsDir, d.name, "package.json"), "utf8"));
      return pj.private === true ? null : { name: pj.name, version: pj.version };
    } catch {
      return null; // no/unreadable package.json → not a publishable workspace
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

const isLive = (name, version) => {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { cwd: root, encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() === version;
};

console.log(`iris release: publishing ${publishable.length} public workspaces to npm (per-package, idempotent)…`);
let published = 0;
let skipped = 0;
for (const pkg of publishable) {
  if (isLive(pkg.name, pkg.version)) {
    console.log(`  = ${pkg.name}@${pkg.version} already live — skip`);
    skipped++;
    continue;
  }
  let ok = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = spawnSync("npm", ["publish", "--workspace", pkg.name, "--access", "public"], {
      cwd: root,
      stdio: "inherit",
    });
    if (r.status === 0) {
      ok = true;
      break;
    }
    // A failure that nonetheless landed (a race / retried PUT) counts as done.
    if (isLive(pkg.name, pkg.version)) {
      ok = true;
      break;
    }
    if (attempt === 6) break;
    const backoffMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1)); // 5s,10s,20s,40s,60s
    console.error(
      `  ! ${pkg.name} publish failed (attempt ${attempt}/6) — retrying in ${backoffMs / 1000}s ` +
        `(npm rate-limit E429 is the usual cause).`,
    );
    await sleep(backoffMs);
  }
  if (!ok) {
    console.error(
      `iris release: FAILED to publish ${pkg.name}@${pkg.version} after retries.\n` +
        "  Re-running is safe — already-published packages are skipped, so a re-push of the\n" +
        "  version tag completes the remaining packages.",
    );
    process.exit(1);
  }
  published++;
  await sleep(2_000); // gentle inter-publish spacing to stay under the burst limit
}
console.log(`iris release: done — ${published} published, ${skipped} already live (of ${publishable.length}).`);
