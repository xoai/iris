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

console.log("iris release: publishing the public workspaces to npm…");
npm(["publish", "--workspaces", "--access", "public"]);
