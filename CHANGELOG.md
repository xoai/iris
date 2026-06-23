# Changelog

All notable changes to Iris are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All publishable
packages (`iris-runtime` + the `@irisrun/*` libraries) share one lockstep version.

## [Unreleased]

## [0.4.0] — 2026-06-23

Reaching agents *outward*: an agent can now call HTTP/JSON APIs as tools
(generated from an OpenAPI spec), persist to three more host databases, front
three more chat platforms via a forkless loader, and run its subprocess tools
inside the sandbox — every one opt-in and byte-identical when off, every one
preserving the zero-external-dependency core.

### Added

- **Multi-platform `iris deploy --target <name>`** — deploy now scaffolds a
  turnkey project for **nine targets** across three runtime families, not just
  Cloudflare: **edge** (`cloudflare` — Workers + Durable Objects); **container**
  (`render`, `gcp-cloud-run`, `azure-container-apps`, `digitalocean-app`,
  `docker` — a shared `Dockerfile` running `iris serve` + a per-platform manifest,
  durable store selected by `IRIS_STORE`, sqlite by default); and **serverless**
  (`aws-lambda`, `gcp-cloud-functions`, `azure-functions` — a cold-per-turn handler
  with an external store via `DATABASE_URL`). A new deploy-target registry
  (`packages/cli/src/deploy-targets.ts`) runs the capability-diff gate per target,
  so a local-tool agent is routed to a container instead of refused at the edge.
  `--target` defaults to `cloudflare` (byte-identical to before); `--list-targets`
  lists them. Real `wrangler deploy` egress stays env-gated; every other target is
  scaffold-only with a printed deploy command. **Zero new runtime dependencies**
  (scaffolds are generated strings); `@irisrun/host` and `@irisrun/store-do` are
  untouched.
- **HTTP transport + OpenAPI 3.0 → tools generator** — an agent can call an
  HTTP/JSON API as tools, generated from an OpenAPI 3.0 spec (opt-in via
  `openapi.json` + `--openapi` on `build` / `verify` / `run`; off by default →
  byte-identical). A new `http` transport in `@irisrun/tools` (`node:fetch`; the
  auth secret rides the `Authorization` header only, never the URL;
  `AbortController` timeout; 2xx JSON → value). The `http://` ref scheme was added
  across every drift-guarded surface (contract schemes, the published schema, the
  `ToolContract` / `LockTool` transport unions) with the conformance corpus kept in
  agreement. **Subagent tool-transport parity**: subagent children now get
  subprocess + mcp + http, closing a `no_transport` gap.
- **MySQL, Redis & MongoDB store adapters** — `@irisrun/store-mysql` (SQL,
  `FOR UPDATE` fenced append, `mysql2`), `@irisrun/store-redis` (KV, optimistic
  `WATCH`/`MULTI`/`EXEC`, `redis` v4), and `@irisrun/store-mongo` (document, single-doc
  `findOneAndUpdate` reservation, `mongodb`) — three peer-dependency-only host stores
  mirroring `@irisrun/store-postgres`, each a `StateStore` + `Scheduler` certified
  against `@irisrun/store-conformance` and pluggable via the existing forkless
  `--store <module>` loader (no CLI change). Drivers are **optional peers** imported via
  a non-literal specifier, so Iris's tree stays zero-dependency and a missing driver
  fails loudly naming the install command. Redis/Mongo run the full conformance suite
  against a faithful fake driver plus an env-gated live smoke; MySQL via unit tests + an
  env-gated live smoke.
- **Forkless bridge loader + `iris bridge` command** — channel bridges are now
  pluggable like stores. A bridge module exports an `OpenBridge` factory
  (`openBridge() → PlatformAdapter`, config from env); `iris bridge <module>
  --base-url <channelUrl>` dynamic-imports it, builds `makePlatformBridge`, and serves
  it in front of a running channel over `node:http` (string replies as XML, objects as
  JSON) — the channel analog of `--store`, adding no dependency to Iris. New reference
  bridges **WhatsApp** (`X-Hub-Signature-256`), **Twilio** (`X-Twilio-Signature`) and
  **Google Chat** (shared token) join the existing Discord / Telegram / Teams examples;
  all six now load via the command. Bridges stay reference examples (Iris owns no
  platform API drift) and depend only on `@irisrun/bridge`; only the loader is
  first-party.
- **`@irisrun/sandbox` wired into the tool loop via `--sandbox`** — a subprocess
  tool can now run inside `@irisrun/sandbox`, opt-in via `iris run | serve | chat
  --sandbox`, off by default (byte-identical when off). A zero-value-off
  `SandboxExecutor` seam sits on the subprocess transport (dependency-inverted —
  `@irisrun/tools` never imports `@irisrun/sandbox`); the CLI builds the executor from
  the Agentfile `sandbox` block and refuses inmemory-for-real / non-node / multi-file
  tools loudly. Real in-docker execution is a gated docker smoke (single-file node
  tools); CI verifies the seam without docker.
- **Connections & Sandbox guides + a dedicated stores page** —
  `docs/guides/connections.md` (consuming external services as tools — OpenAPI / mcp /
  grpc / subprocess, the two credential layers, approvals), `docs/guides/sandbox.md`
  (the security floor as a library + the opt-in wiring), and a new `docs/stores.md`
  durability-backends page (the store-side counterpart to `channels.md`: the plug-and-play
  table, one conformance suite, per-substrate notes). `docs/sdk.md` gains an **"Adapter
  or bridge?"** section + an ASCII diagram clarifying the in-process port adapter vs the
  external bridge boundary. All reachable through the docs-funnel integrity guard.

### Changed

- **`examples/` relocated to the top level** (was `tests/examples/`) — the bridge
  reference adapters are user-facing now (`iris bridge ./examples/bridges/<x>.ts` is a
  documented command), so a path under `tests/` undersold them. Every reference
  repointed: the test imports, the two `npm run demo:*` scripts, the tsconfig exclude,
  and all doc / README / CONTRIBUTING paths.

### Hardened

- The full suite stands at **1088 passing** (from 955 at 0.3.0; +6 live-gated
  conformance tests). Zero new runtime dependencies in Iris's core; the new store
  drivers (`mysql2` / `redis` / `mongodb`) are optional peers, never pulled into
  Iris's own tree.

## [0.3.0] — 2026-06-22

The **forkless adapter ecosystem**: a single-dependency SDK for authoring
storage / provider / channel / bridge adapters, three importable conformance suites
that certify them, runtime loaders that plug a third-party adapter into the CLI
without a fork, and a reference Postgres store — all preserving Iris's
zero-external-dependency core and byte-identical defaults. One lockstep version
across `iris-runtime` + every `@irisrun/*`.

### Added

- **`@irisrun/sdk` — one-dependency adapter authoring** — a curated, zero-runtime-logic
  re-export surface: the three port type-sets (store / provider / channel), the three
  `run*Conformance` suites with one canonical `register` / `ConformanceCase`, the
  `ConformanceFixture` helper, and the forkless-loader contracts
  (`OpenStore` / `OpenProvider` / `OpenChannel`). Author a conformant adapter against a
  single dependency. Guide: `docs/sdk.md`.
- **Forkless adapter loaders** — plug a third-party adapter into the CLI without forking
  it: `--store <module>` (run / serve / chat / audit / schedule), `--provider <module>`
  and `--channel <module>` (run / serve / chat). Built-ins (sqlite/fs/memory, the
  prefix→provider default, the REST channel) stay the default and **byte-identical**;
  any other value is dynamic-imported and its `openStore` / `openModelProvider` /
  `openChannel` factory used. A bad or unresolvable module is refused loudly.
- **`iris adapter init <kind>`** — scaffolds a buildable, conformance-wired adapter
  package (one `@irisrun/sdk` dep + tsconfig + README + factory + test). The **store**
  scaffold ships a correct in-memory store whose conformance suite is green out of the
  box; channel/provider ship the port shape + wiring with marked TODOs. No-clobber;
  unknown kind refused loudly.
- **Importable conformance suites** — `@irisrun/store-conformance`,
  `@irisrun/channel-conformance`, and `@irisrun/provider-conformance`: runner-agnostic
  (never import `node:test`), each returns a `{name, fn}[]` that `register()` wires into
  any runner. All first-party adapters were migrated onto them with no coverage
  regression, plus gap cases (token replay, cross-session tokens, concurrency, the
  contended-rotation chains) and an opt-in `{concurrency}` stress that catches racy
  backends. Each ships a "teeth" meta-test proving the suite fails a contract-violating
  adapter.
- **`@irisrun/bridge` — the bridge SDK** — the proven, zero-dependency bridge reference
  code promoted into a published package: `makeBridgeSession` + `makePlatformBridge` +
  `PlatformAdapter`, plus `runBridgeConformance` / `runAdapterConformance` (certified
  against an in-package fake REST channel, so the package keeps zero deps). The
  Discord / Telegram / Teams adapters remain **reference examples** (Iris never owns
  platform API drift) and now build on the SDK.
- **`@irisrun/store-postgres` — reference Postgres store** — a host `StateStore` +
  `Scheduler` on PostgreSQL, plugged in via the loader
  (`--store @irisrun/store-postgres --db postgres://…`). `pg` is an **optional peer**
  imported via a non-literal `import()`, so Iris's own tree stays
  zero-external-dependency and the package typechecks/builds with no `pg` present.
  Append is one `FOR UPDATE`-locked transaction (linearization, fence-before-seq,
  truncation-surviving high-water mark); certified by the env-gated live-PG smoke
  running the same `@irisrun/store-conformance` cases the built-ins pass.
- **MCP-server tools wired at runtime** — an `mcp.json` beside the image
  (`--mcp <file>` override) maps each `mcp://` tool to a `{command, args}`, so an
  `mcp://` tool now resolves *and runs* (previously it resolved at build then failed at
  run time). The image's scoped tool env reaches the server (`McpStdioOptions.env`,
  additive in `@irisrun/tools`), so an MCP memory/tool gets its API key like a
  subprocess tool. No `mcp.json` → byte-identical.
- **Per-child subagent models** — declare `model` / `baseUrl` / `apiKeyEnv` per child in
  `subagents.json` for heterogeneous teams (e.g. PM / Engineer / QC each on a different
  model or endpoint).
- **Use-case recipe guides** — `docs/sdk.md` plus seven scenario recipes (multi-agent
  teams, autoresearch loop, automated workflow on Cloudflare DO + self-host VPS,
  human-in-the-loop approvals, run-on-any-provider, never-lose-state portability, an
  auditable agent) and a full coding-team guide (PM/Engineer/QC on three models +
  Postgres + mem0 + Telegram), all reachable through the docs-funnel integrity guard.

### Changed

- **`iris deploy` refuses the forkless flags loudly** — `--store` / `--provider` /
  `--channel` are deploy-incompatible (the portable image must stay endpoint- and
  adapter-neutral), so deploy rejects them before running rather than silently dropping
  them. Enforced by a behavioral test.

### Hardened

- The full suite stands at **955 passing** (from 801 at 0.2.0), the three new importable
  conformance suites adding ~150 net cases. Zero new runtime dependencies; the pure core
  and `@irisrun/audit` stay Node-free; `@irisrun/store-postgres` is the only package with
  an external dependency (`pg`, an optional peer).

## [0.2.0] — 2026-06-21

The **roadmap-v0.2** cycle: a verifiable portable journal, breadth across
providers and channels, Agentfile secrets/environment, and a depth-hardening
pass (adversarial sandbox review + chaos/concurrency + live-provider
conformance). One lockstep version across `iris-runtime` + every `@irisrun/*`.

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
  channel-port conformance suite. Normative `docs/reference/channel-port-spec.md`.
- **Slack channel for durable HITL** — `@irisrun/channel-slack`: a Slack approval
  that pauses for hours, survives a redeploy, and resumes the same session
  byte-identically (the approval context rides the signed Slack button value; the
  durable session is the journal). Constant-time signature verification.
- **Bridge pattern for everything else** — `docs/reference/bridge-pattern.md` + a
  fetch-only reference bridge (`npm run demo:bridge`), plus reference bridges for
  **Discord** (Ed25519), **Telegram** (secret token), and **Microsoft Teams**
  (Outgoing-Webhook HMAC) — external processes speaking the REST channel protocol,
  so new platforms need no core changes (and aren't first-party packages).
- **`iris journal`** — export / verify / import a verifiable, content-addressed
  session journal (`@irisrun/journal-export`).

### Changed

- **`iris init` scaffolds `agent.yaml` by default** (was `agent.json`) — the YAML
  scaffold is self-documenting (commented `secrets:` / `environment:` examples). Use
  `iris init --json` for the JSON form; both remain first-class to `iris build`.
- **Docs reorganized** — all deep-dive specs and threat models (the channel-port and
  bridge specs, the verifiable-journal spec, and both threat models) now live under
  `docs/reference/`; the docs index separates the linear funnel from reference material.

### Security

- Subprocess-tool env is host-side and **least-privilege-scoped** to the declared
  names plus a non-secret base; undeclared `--env` / `--env-file` keys are refused.
  Inline `--env` of a declared secret warns (its value is exposed in the process
  list / shell history) — prefer `--env-file` or `--secret-files`. This is a
  distinct layer from the sandbox egress credential broker (see
  `docs/reference/security-sandbox-threat-model.md`).
- **Sandbox egress proxy hardened under an adversarial review** — the docker-backend
  host-side sidecar (deny-all by default, per-host allowlist brokering) was
  re-examined against an adversarial threat model and locked down by a dedicated
  adversarial test suite. The analysis is documented in
  `docs/reference/security-sandbox-threat-model.md`.

### Hardened

- **Replay fidelity across real providers** — provider request/response
  canonicalization plus a model-call replay-fidelity pass and live-provider
  conformance gates confirm that the deterministic-replay guarantee holds against
  actual OpenAI- and Anthropic-protocol endpoints, not just recorded fixtures.
- **Chaos & concurrency** — a crash-injection suite exercises recovery
  (at-least-once + idempotency, checkpoint-before-effect) under concurrent sessions.

The suite stands at **801 passing** (+6 env-gated live-provider tests); zero new
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

[Unreleased]: https://github.com/xoai/iris/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/xoai/iris/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/xoai/iris/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xoai/iris/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xoai/iris/releases/tag/v0.1.0
