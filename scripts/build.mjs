// Publish build: compile every publishable package's src/*.ts → dist/*.js (+ .d.ts)
// so the npm artifacts are importable once installed (Node won't type-strip .ts under
// node_modules). Dev is unaffected — `npm test`/`typecheck` resolve @irisrun/* to src via
// the `iris-src` export condition; this build only runs at publish (via release.mjs).
//
// Each package compiles INDEPENDENTLY (order-free): cross-package imports are bare
// (`@irisrun/core`) and resolve to deps' SRC for types through the iris-src condition, so
// no dist needs to exist for a dependency. The per-package tsconfig.build.json is a
// generated, gitignored artifact (extends tsconfig.build.base.json).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = join(root, "packages");

// tsc's rewriteRelativeImportExtensions rewrites `./x.ts`→`./x.js` in the emitted
// .js but NOT in the emitted .d.ts (a TS 6.0.3 gap), leaving non-standard `.ts`
// specifiers that error strict consumers. Rewrite relative `.ts` → `.js` in every
// emitted .d.ts (guarding against an already-`.d.ts` specifier, which never occurs
// in our emit but is excluded for safety).
function fixDtsExtensions(distDir) {
  if (!existsSync(distDir)) return;
  for (const e of readdirSync(distDir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith(".d.ts")) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    const src = readFileSync(p, "utf8");
    const out = src.replace(
      /(["'])(\.\.?\/[^"']*?)\.ts(["'])/g,
      (m, q1, spec, q2) => (spec.endsWith(".d") ? m : `${q1}${spec}.js${q2}`),
    );
    if (out !== src) writeFileSync(p, out);
  }
}

const PER_PKG_CONFIG = JSON.stringify(
  {
    extends: "../../tsconfig.build.base.json",
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/**/*.ts"],
  },
  null,
  2,
) + "\n";

const publishable = readdirSync(pkgsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => {
    try {
      return JSON.parse(readFileSync(join(pkgsDir, d.name, "package.json"), "utf8")).private !== true;
    } catch {
      return false;
    }
  })
  .map((d) => d.name)
  .sort();

let failed = 0;
for (const pkg of publishable) {
  const pkgDir = join(pkgsDir, pkg);
  const cfg = join(pkgDir, "tsconfig.build.json");
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true }); // clean rebuild
  writeFileSync(cfg, PER_PKG_CONFIG);
  const r = spawnSync("npx", ["tsc", "-p", cfg], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`build: FAILED for ${pkg}`);
    failed++;
  } else if (!existsSync(join(pkgDir, "dist", "index.js"))) {
    console.error(`build: ${pkg} emitted no dist/index.js`);
    failed++;
  } else {
    fixDtsExtensions(join(pkgDir, "dist")); // .ts → .js in emitted .d.ts (TS 6 gap)
  }
}

if (failed > 0) {
  console.error(`\nbuild: ${failed}/${publishable.length} package(s) failed`);
  process.exit(1);
}
console.log(`\nbuild: ${publishable.length} packages compiled to dist/`);
