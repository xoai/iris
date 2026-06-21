# Releasing Iris to npm

Iris is **published on npm at `0.2.0`** — `iris-runtime` (the CLI) plus the
`@irisrun/*` libraries. This document is how to cut the next release: a `tsc` build
compiles each package to JS, the metadata is set (names, versions, `publishConfig`,
`files`, `repository`), and `npm run release` is wired and gated behind `IRIS_PUBLISH=1`.

## How the build works (no dev build step)

Iris is authored as raw TypeScript and runs with **no build step in development** —
Node 24 strips the types at load, and the workspace resolves `@irisrun/*` to each
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
    "default":  "./dist/index.js"    // published consumers / npx iris-runtime
  }
}
```

`npm run build` (`scripts/build.mjs`) compiles every publishable package's
`src/*.ts` → `dist/*.js` (+ `.d.ts`) with `tsc` (already a devDependency — no new
dep). It uses `rewriteRelativeImportExtensions`, so the explicit `./x.ts` import
specifiers become `./x.js` in the emitted JS; bare `@irisrun/*` imports are kept and
resolve to each dep's published `dist` at install time. (`tsc` 6.0 does not apply
that rewrite to the emitted `.d.ts`, so the build does a post-emit pass that
rewrites relative `.ts` → `.js` in the declaration files — without it, a strict
consumer typechecking the shipped types hits "import path can only end with .ts".)
Packages compile independently (cross-package types resolve to `src` via the
`iris-src` condition), so order doesn't matter. `dist/` and the generated
`tsconfig.build.json` are git-ignored build artifacts.

## Cutting a release (recommended: CI/CD)

Releases are automated by `.github/workflows/release.yml`, which keeps the git tag
and the npm version **in sync** and publishes on a version tag.

**One-time setup:** add an npm **Automation** access token as the repo secret
`NPM_TOKEN` (npmjs.com → Access Tokens → Generate → Automation → then GitHub repo
→ Settings → Secrets and variables → Actions → `NPM_TOKEN`). An automation token
bypasses 2FA, which non-interactive publishing requires (a normal token fails with
`EOTP` in CI).

**To release version `X.Y.Z`:**

```sh
node scripts/version.mjs X.Y.Z      # or: npm run version:set -- X.Y.Z
git commit -am "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"       # MUST be annotated — see note below
git push --follow-tags
```

> **The tag must be annotated** (`git tag -a`). `git push --follow-tags` only
> pushes *annotated* tags, so a lightweight `git tag vX.Y.Z` is silently left
> behind and the release workflow never fires. Push it explicitly if in doubt:
> `git push origin vX.Y.Z`.

`scripts/version.mjs` sets every `packages/*` version **and** rewrites the internal
`@irisrun/*` dependency ranges to `^X.Y.Z` (they move in lockstep). On the pushed
tag, the workflow: verifies `vX.Y.Z` equals `packages/cli/package.json` (fails
loudly on drift), runs typecheck + the full suite, publishes via `npm run release`
(skipping packages whose version is already live — so re-pushing a tag is safe),
and cuts a GitHub Release. `v0.0.1` predates this; `v0.1.0` is the first synced tag.

### If a publish is interrupted (npm rate-limit / partial release)

Publishing a monorepo of ~31 packages can trip npm's per-token publish
rate-limit (`E429 Too Many Requests — rate limited exceeded`) part-way through,
leaving some packages at the new version and the rest behind. `npm run release`
publishes **per package and idempotently** — it skips every package already live
at the target version and only publishes the rest, aborting fast if npm is
throttling the whole token (rather than hammering the registry). To finish a
partial release, **wait for the rate-limit to cool down (~15–30 min), then
re-run** by re-pushing the tag:

```sh
git push -f origin vX.Y.Z     # re-fires the workflow; the publish resumes where it stopped
```

It will skip what's already live and publish only what remains. Verify the whole
set landed with `npm view <pkg>@X.Y.Z version` for each, or just re-run until the
publish step reports `0 still missing` and the GitHub Release is created.

## How to publish manually (fallback)

1. `npm login` (an account with publish rights to `iris-runtime` and the `@irisrun` scope).
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
   `iris-workspace` (the repo root) and `@irisrun/demo` are not published.

## What gets published

- **`iris-runtime`** — the unscoped CLI package (`bin.iris` → `./dist/cli-main.js`,
  so the installed command is `iris`); the package behind `npx iris-runtime` /
  `npm i -g iris-runtime`. (Named `iris-runtime` because the bare `iris` name and
  the `@iris` scope are owned by others on npm; the binary stays `iris`.)
- **`@irisrun/*`** — the libraries: `core`, `tools`, `agent`, `host`,
  `channel-core`, `channel-rest`, `channel-web`, `channel-mcp`, `channel-slack`,
  `client-sdk`, `store-do`, `store-fs`, `store-memory`, `store-sqlite`,
  `provider-anthropic`, `provider-openai`, `provider-compat`, `auth`, `audit`,
  `subagents`, `schedule`, `bundle-coding`, `inspect`, `observe`, `evals`,
  `journal-export`, `sandbox`.

All publishable packages share one lockstep version (currently `0.2.0`) and
publish with public access via `publishConfig`.

**Not published:** `iris-workspace` (the private monorepo root) and `@irisrun/demo`
(an in-repo example, consumed from source).

## Running the CLI from source (without installing)

Because dev resolves `@irisrun/*` to `src`, run the CLI from the workspace with the
condition flag (no build needed):

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts init ./my-agent
```

Or build once and run the compiled bin: `npm run build && node packages/cli/dist/cli-main.js …`.
