# Contributing to Iris

Thanks for looking under the hood. Iris is an **install-free, Node-24 monorepo** — you
can clone it and have the full suite running in under a minute, no build step.

## Prerequisites

- **Node ≥ 24** (the only hard requirement; see `engines` in `package.json`).
- That's it. Iris has **zero runtime dependencies**; the dev tooling is just
  `typescript` + `@types/node`.

## The dev loop

```sh
git clone https://github.com/xoai/iris && cd iris
npm install            # workspaces — links the packages, pulls the two devDeps

npm test               # the whole suite on node:test — green with no API key, no infra
npm run typecheck      # tsc --noEmit across every package + the tests
```

There is **no build step** for development. Source runs directly through the
`iris-src` export condition — every package's `package.json` maps its public entry to
`./src/*.ts` under that condition. So the CLI and the demos run straight from source:

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts <cmd>     # the `iris` bin, from source
node --conditions=iris-src examples/portability-demo.ts     # the cross-host proof
```

`npm run build` exists (it compiles `dist/` for publishing), but you don't need it to
develop or test.

## What CI gates

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
on Node 24 — exactly three steps:

```
npm ci  →  npm run typecheck  →  npm test
```

If those pass locally, they pass in CI. Keep them green.

## House rules (read before your first PR)

These are enforced, not aspirational — see **[conventions](docs/conventions.md)** for the
full contract. The short version:

- **`@irisrun/core` stays pure.** It imports only relative specifiers — no `node:`
  builtins, no host/transport packages, no third-party deps. A test
  (`tests/lib/scan-imports.ts`) fails the build if you break it.
- **Zero external runtime dependencies**, everywhere. Host-specific code lives in a
  host-side adapter, never in the core.
- **No silent failures.** Refuse loudly — a wrong/missing input throws or returns a
  named error; never a quiet success.
- **Tests before code.** Every behavior has a test; the suite is the spec.

## Project shape

- **[Architecture](docs/architecture.md)** — how the ~29 packages fit together: the pure
  core, the two host ports (`StateStore` / `Scheduler`), and the adapter layers.
- **[Test strategy](tests/README.md)** — `lib/` (the shared harness + conformance
  suites), `examples/` (runnable, test-verified), `smoke/` (gated real-egress checks).
  The default `npm test` needs no key and no infra.

## Extending Iris

Each extension point has a conformance suite — passing it is the definition of "done":

- **[Add a provider](docs/contributing/adding-a-provider.md)** — a new model backend.
- **[Add a channel](docs/contributing/adding-a-channel.md)** — a new transport.
- **[Add a store adapter](docs/contributing/adding-a-store.md)** — a new host backend.
- **[Add a tactic](docs/contributing/adding-a-tactic.md)** — change how the agent thinks.

## Commits, branches, releases

- Branch off `main`; keep a PR focused on one change.
- Commit subjects follow a conventional `type: summary` style (`feat:` / `fix:` /
  `docs:` / `chore:`), matching the existing history.
- A PR merges once CI is green and the change has a test.
- Releases are lockstep-versioned and gated — see [`RELEASING.md`](RELEASING.md). You do
  not publish; a maintainer cuts the release.
