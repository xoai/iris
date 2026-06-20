# Conventions

The house rules a contribution must respect. They aren't style preferences — most are
enforced by a test or the type system, and they're the reason the codebase stays small,
portable, and replay-safe.

## 1. The core is pure

`@irisrun/core` may import **only relative specifiers**. No `node:` builtins, no
host/transport packages (`@irisrun/store`/`host`/`channel`/`provider`, `sqlite`, `pg`,
`ws`, `express`, `@grpc/*`, …), no third-party dependency at all.

This is enforced: `tests/lib/scan-imports.ts` statically scans every `.ts` under
`core/` and fails the build on the first non-relative import. The rule directly encodes
"core carries no host concern," which is what keeps it edge- and WASM-reachable. If your
change needs `node:fs`, a database driver, or `fetch`, it belongs in a **host-side
adapter**, not the core.

## 2. Zero external runtime dependencies

The whole project ships with no runtime `dependencies` — only `@irisrun/*` workspace
packages depend on each other, and the dev tooling is `typescript` + `@types/node`.
Reach for a Node builtin or hand-roll it before adding a dependency; a new dep needs a
real justification. (This is why the WebSocket codec, the OCI layout, and the SSE parser
are all in-repo.)

## 3. No silent failures

Refuse **loudly**. A missing secret, a stale token, an over-capable image, an unknown
seam — each throws or returns a *named* error, never a quiet success or a half-started
session. The pattern recurs because it's load-bearing: a silent degrade in a durability
runtime corrupts the journal. When you add a failure path, make it observable.

## 4. Host-side vs. pure

A quick test for where code goes: **does it touch the outside world?**

- Reads/writes bytes, opens a socket, spawns a process, calls an API, reads the clock or
  env → **host-side** (a store/host/channel/provider/tool/sandbox package).
- Folds journaled data into state, decides, validates, derives → **pure** (core, or a
  pure projection like `inspect`/`observe`).

A tactic *advises*; the kernel *performs*. A reducer never reads `ts`; only an after-the-fact
projection (like `observe`) may. Keep the two sides apart and replay stays deterministic.

## 5. Tests before code

Every behavior has a test, and the suite is the spec. The default `npm test` is
**install-free and deterministic** — no API key, no infrastructure (see
[test strategy](../tests/README.md)). Extension points ship a **conformance suite**
(`tests/lib/*-conformance.ts`); passing it is the definition of a correct adapter. Live
or real-egress paths are **gated smokes** under `tests/smoke/`, never in the default run.

## 6. Changes stay reversible

Migrations are reversible; the published packages share **one lockstep version** and
publish together (see [`RELEASING.md`](../RELEASING.md)). Pinning is by content digest, so
an image — and a recorded session — reproduces exactly.

---

These follow from the shape in [architecture](./architecture.md); the dev loop that
checks them is in [CONTRIBUTING](../CONTRIBUTING.md).
