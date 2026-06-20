# Changelog

All notable changes to Iris are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All publishable
packages (`iris-runtime` + the `@irisrun/*` libraries) share one lockstep version.

## [Unreleased]

### Added

- **Configurable provider endpoints + a conformance-verified compatibility matrix**
  — `@irisrun/provider-compat` ships a registry of OpenAI- and Anthropic-protocol
  endpoints (Groq, Together, Fireworks, OpenRouter, DeepSeek, Mistral, xAI, vLLM,
  Ollama, LM Studio, Azure OpenAI, Bedrock, Vertex) classified **replay-safe vs
  known-divergent**, each pinned by a CI conformance test. New `iris providers
  [--matrix]`; `--base-url` / `IRIS_MODEL_BASE_URL` on `iris run` / `serve` / `chat`
  point a portable image at any compatible endpoint (a deploy-time knob — the image
  digest stays endpoint-neutral).
- **The channel as a narrow port** — `@irisrun/channel-core` factors the
  two-identifier protocol (mint sessionId, own/rotate a single-use continuation
  token with committed-only rotation, atomic single-use, loud refusal taxonomy,
  `normalizeInbound`/`emitOutbound`) into one shared driver. `@irisrun/channel-rest`
  and `@irisrun/channel-mcp` are now built on it and both pass one shared
  channel-port conformance suite. Normative `docs/channel-port-spec.md`.
- **Slack channel for durable HITL** — `@irisrun/channel-slack`: a Slack approval
  that pauses for hours, survives a redeploy, and resumes the same session
  byte-identically (the approval context rides the signed Slack button value; the
  durable session is the journal). Constant-time signature verification.
- **Bridge pattern for everything else** — `docs/bridge-pattern.md` + a fetch-only
  reference bridge (`npm run demo:bridge`), plus reference bridges for **Discord**
  (Ed25519), **Telegram** (secret token), and **Microsoft Teams** (Outgoing-Webhook
  HMAC) — external processes speaking the REST channel protocol, so new platforms
  need no core changes (and aren't first-party packages).
- **`iris journal`** — export / verify / import a verifiable, content-addressed
  session journal (`@irisrun/journal-export`).

The suite now stands at **754 passing** (+6 env-gated live-provider tests). Zero new
runtime dependencies; the pure core and `@irisrun/audit` stay Node-free.

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
