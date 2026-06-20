# Changelog

All notable changes to Iris are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All publishable
packages (`iris-runtime` + the `@irisrun/*` libraries) share one lockstep version.

## [Unreleased]

### Added

- **Agentfile secrets & environment** — declare `secrets:` (names of required
  runtime secrets) and `environment:` (non-secret literal defaults) in the
  Agentfile; supply secret values at run time with `--env-file <file>` /
  `--env KEY=VAL` on `run` / `serve` / `chat`. Subprocess tools receive a
  **least-privilege** environment — only the declared env plus a fixed
  PATH/HOME/proxy/TLS base, never the operator's whole shell — and a missing or
  undeclared secret refuses to run, loudly and by name. Secret VALUES never enter
  the manifest, image, journal, or any error message. `iris inspect` shows what an
  image requires.
- **File-mount secrets** (`--secret-files`) — each secret is written to a `0600`
  temp file and the tool receives `<NAME>_FILE=<path>` instead of the value, so the
  secret never enters the tool's environment (the `*_FILE` convention used for
  `/run/secrets/*`).
- **`iris init --json`** — opt into a JSON Agentfile (YAML is now the default).
- **`iris build` Agentfile auto-detection** — with no `--file`, builds the first of
  `agent.json` / `agent.yaml` / `agent.yml` (warns when more than one is present).
- **YAML empty-collection literals** — `[]` / `{}` are now authorable (e.g.
  `skills: []`), so a no-skills / no-connections agent can be written in YAML.

### Changed

- **`iris init` scaffolds `agent.yaml` by default** (was `agent.json`) — the YAML
  scaffold is self-documenting (commented `secrets:` / `environment:` examples). Use
  `iris init --json` for the JSON form; both remain first-class to `iris build`.
- **Docs reorganized** — deep-dive specs and threat models moved under
  `docs/reference/`; the docs index now separates the linear funnel from reference
  material.

### Security

- Subprocess-tool env is host-side and **least-privilege-scoped** to the declared
  names plus a non-secret base; undeclared `--env` / `--env-file` keys are refused.
  Inline `--env` of a declared secret warns (its value is exposed in the process
  list / shell history) — prefer `--env-file` or `--secret-files`. This is a
  distinct layer from the sandbox egress credential broker (see
  `docs/reference/security-sandbox-threat-model.md`).

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
