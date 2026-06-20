# Changelog

All notable changes to Iris are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All publishable
packages (`iris-runtime` + the `@irisrun/*` libraries) share one lockstep version.

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-06-20

First public release on npm: a portable durability runtime for stateful agents.
The CLI publishes as **`iris-runtime`** (binary `iris`); the libraries as
**`@irisrun/*`**.

### Added

- **Durability core** — an event-sourced session journal with deterministic
  replay, an always-on replay-consistency assertion, crash recovery
  (at-least-once + idempotency, checkpoint-before-effect), snapshots, and
  byte-identical cross-host migration. Regression-locked by a 592-test suite
  (incl. a 10,000-session determinism run and a cross-host resume).
- **Image toolchain** — declarative `Agentfile` (JSON/YAML) parsed/validated with
  content embedded by hash and tool/connection contracts pinned by digest;
  deterministic `imageDigest`, content-addressed OCI layout, loud `verify`,
  session pinning + definition migration.
- **Published Agentfile JSON Schema** (draft 2020-12) via `iris schema`, kept
  drift-locked to the runtime validator by a shared conformance corpus.
- **Tool boundary** — in-process / subprocess / MCP / gRPC transports behind one
  digest-pinned contract; a batteries-included `now` subprocess tool from
  `iris init`.
- **Channels & streaming** — REST (`node:http`) and MCP (stdio) channels with the
  single-use continuation-token discipline; live SSE + hand-rolled WebSocket
  streaming; a `--web` browser chat UI (`@irisrun/channel-web`) and an isomorphic
  client SDK (`@irisrun/client-sdk`).
- **Providers** — Anthropic and OpenAI behind one provider-agnostic, conformance-
  tested port; model selected by id prefix.
- **Governance** (`@irisrun/auth`) — principal identity, a declarative
  who-may-approve policy on the approval gate, and a journaled, replayable
  approval trail; reachable via `iris serve --policy` and inline in `iris chat`
  (`approve? [y/n]`).
- **Audit & evals** — whole-session, replay-verified compliance audit
  (`iris audit`, `@irisrun/audit`) and provably reproducible evals (`iris eval`,
  `@irisrun/evals`).
- **Deploy** — one-command Cloudflare Durable Objects scaffold (`iris deploy`)
  with a capability-diff gate.
- **Sandbox** — deny-all network + credential brokering, with real per-host
  allowlist egress for the docker backend via a host-side sidecar egress proxy.
- **Subagents & schedules** on the journaled substrate (`subagents.json`,
  `iris schedule`).
- **CLI surface** — `init · build · inspect · schema · verify · push · pull · run
  · serve · chat · deploy · audit · eval · schedule`.

[Unreleased]: https://github.com/xoai/iris/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xoai/iris/releases/tag/v0.1.0
