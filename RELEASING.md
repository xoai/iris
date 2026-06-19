# Releasing Iris to npm

The package tree is publish-ready: a `tsc` build compiles each package to JS, the
metadata is set (names, versions, `publishConfig`, `files`, `repository`), and
`npm run release` is wired and gated behind `IRIS_PUBLISH=1`.

## How the build works (no dev build step)

Iris is authored as raw TypeScript and runs with **no build step in development** —
Node 24 strips the types at load, and the workspace resolves `@iris/*` to each
package's `src/` via a custom export **condition** (`iris-src`). `npm test` and
`npm run typecheck` carry that condition (`NODE_OPTIONS=--conditions=iris-src` /
tsconfig `customConditions`), so day-to-day work needs no compile.

A *published* package is different: Node refuses to type-strip `.ts` files that
live under an installed `node_modules` tree, so the artifact must ship JavaScript.
Each `package.json` `exports` therefore resolves to compiled `dist/*.js` **by
default** (and `./src/index.ts` only under the `iris-src` condition):

```jsonc
"exports": {
  ".": {
    "iris-src": "./src/index.ts",   // dev (workspace + tests)
    "types":    "./dist/index.d.ts", // published types
    "default":  "./dist/index.js"    // published consumers / npx iris
  }
}
```

`npm run build` (`scripts/build.mjs`) compiles every publishable package's
`src/*.ts` → `dist/*.js` (+ `.d.ts`) with `tsc` (already a devDependency — no new
dep). It uses `rewriteRelativeImportExtensions`, so the explicit `./x.ts` import
specifiers become `./x.js` in the emitted JS; bare `@iris/*` imports are kept and
resolve to each dep's published `dist` at install time. (`tsc` 6.0 does not apply
that rewrite to the emitted `.d.ts`, so the build does a post-emit pass that
rewrites relative `.ts` → `.js` in the declaration files — without it, a strict
consumer typechecking the shipped types hits "import path can only end with .ts".)
Packages compile independently (cross-package types resolve to `src` via the
`iris-src` condition), so order doesn't matter. `dist/` and the generated
`tsconfig.build.json` are git-ignored build artifacts.

## How to publish

1. `npm login` (an account with publish rights to `iris` and the `@iris` scope).
2. Preview what ships — builds, then lists tarball contents (no upload, no registry):
   ```sh
   npm run release:dry
   ```
3. Publish (gated; mirrors `IRIS_DEPLOY=1` for `iris deploy`):
   ```sh
   IRIS_PUBLISH=1 npm run release
   ```
   `scripts/release.mjs` **always builds first**, then runs
   `npm publish --workspaces --access public` and, as a safety net, refuses if any
   publishable package is missing its `dist/`. npm skips `private` workspaces, so
   `iris-workspace` (the repo root) and `@iris/demo` are not published.

## What gets published

- **`iris`** — the unscoped CLI (`bin.iris` → `./dist/cli-main.js`); the package
  behind `npx iris` / `npm i -g iris`. (Renamed from `@iris/cli`; the old scoped
  name is **not** published.)
- **`@iris/*`** — the libraries: `core`, `tools`, `agent`, `host`,
  `channel-rest`, `channel-web`, `channel-mcp`, `client-sdk`, `store-do`,
  `store-fs`, `store-memory`, `store-sqlite`, `provider-anthropic`,
  `bundle-coding`, `inspect`, `observe`, `evals`, `sandbox`.

All publishable packages share one lockstep version (currently `0.1.0`) and
publish with public access via `publishConfig`.

**Not published:** `iris-workspace` (the private monorepo root) and `@iris/demo`
(an in-repo example, consumed from source).

## Running the CLI from source (without installing)

Because dev resolves `@iris/*` to `src`, run the CLI from the workspace with the
condition flag (no build needed):

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts init ./my-agent
```

Or build once and run the compiled bin: `npm run build && node packages/cli/dist/cli-main.js …`.
