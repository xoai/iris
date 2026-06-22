<div align="center">
  <a href="https://github.com/xoai/iris">
    <picture>
      <img alt="iris logo" src="./assets/iris-logo-darkmode-bg.png" height="128">
    </picture>
  </a>
  <h1>IRIS</h1>
  <h3>A portable runtime for durable AI agents</h3>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/iris-runtime"><img alt="npm version" src="https://img.shields.io/npm/v/iris-runtime?style=for-the-badge&logo=npm&logoColor=white&label=iris-runtime&color=CB3837&labelColor=000000"></a>
  <a href="https://nodejs.org"><img alt="Node ≥ 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=000000"></a>
  <img alt="TypeScript — no build step" src="https://img.shields.io/badge/TypeScript-no%20build%20step-3178C6?style=for-the-badge&logo=typescript&logoColor=white&labelColor=000000">
  <img alt="tests: 1045 passing" src="https://img.shields.io/badge/tests-1045%20passing-44CC11?style=for-the-badge&labelColor=000000">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=000000"></a>
</p>

Iris is a portable runtime for durable AI agents — built so an agent is never locked to a single host, model, or vendor. You declare an agent as a config file plus a folder — instructions and skills as files, tools and channels referenced by address — and `iris build` compiles it into an open, content-addressed image: the unit you version, push to any OCI registry, and run anywhere.

**[Features](#key-features)** · **[When to use](#when-to-use-iris)** · **[Compare](#how-iris-compares)** · **[Authoring](#the-agent-is-a-directory)** · **[Install](#install)** · **[Quick start](#quick-start)** · **[How it works](#how-it-works)** · **[Packages](#whats-inside)**

> **New here?** This README is the manifesto — *why* Iris exists. For a guided
> path from `npx iris-runtime init` to a deployed, talkable agent, follow the
> **[docs](docs/README.md)** in order. Building on Iris? Start with
> **[CONTRIBUTING](CONTRIBUTING.md)** and the **[architecture map](docs/architecture.md)**.

## Key features

- **Pause and resume anywhere** — one agent image runs on a laptop, a VPS, a serverless function, or an edge isolate. Stop a session on one and resume it on another, mid-task.
- **You own the state, not the host** — the agent's progress lives in Iris's log, not in a host's memory. The same journal / replay / snapshot code runs everywhere; a host only has to store bytes and wake the agent up.
- **It can't silently drift** — replaying the log always rebuilds the exact same state, and Iris checks this on every step. If a crash interrupts an action, recovery retries it safely (at-least-once with idempotency) — never twice.
- **Config, not code** — describe the agent in a small `Agentfile` (JSON or YAML). Tools live outside the agent and are referenced by address (MCP / gRPC / subprocess), so they can be written in any language and run on any host.
- **Ships like a Docker image** — `iris build` produces a content-addressed image you can `inspect` and `verify`, then **push to any OCI registry and pull and run anywhere**.
- **Talk to it, deploy it in one command** — a built-in web chat UI (`iris serve --web`) and a small isomorphic client SDK (`@irisrun/client-sdk`) put a human in front of the agent, and `iris deploy` lands it on a real edge host (Cloudflare Durable Objects), where a tab close or a host migration resumes the same session.
- **Bring your own model** — the model call is just another recorded step behind a small adapter. Anthropic and OpenAI adapters ship (both pass one shared conformance suite), and any OpenAI- or Anthropic-compatible endpoint (Groq, Together, DeepSeek, vLLM, Ollama, …) is reachable via `--base-url` — classified replay-safe vs known-divergent by a conformance-tested matrix (`iris providers --matrix`). No provider is baked into the core.
- **A small, safe core you can extend** — a thin kernel enforces the safety rules; the agent's decisions (when to summarize context, when to stop, when to ask a human) are pluggable, and every choice is recorded so replay stays exact.
- **Secure by default** — tools run sandboxed with networking denied by default, and credentials are brokered so secrets never enter the sandbox. Real per-host allowlist egress + brokering for the docker backend ride a host-side sidecar egress proxy. Subprocess tools get a **least-privilege, declared environment** — secrets are named in the Agentfile (docker-compose style) and their values supplied at run time (`--env-file` / `--env`), never baked into the image or journal.

## When to use Iris

Reach for Iris when an agent's *state* is the hard part:

- **Long-running tasks that must survive restarts and deploys.** A multi-hour job parks on a timer or an approval and resumes — across a process restart, a redeploy, or days later — exactly where it left off.
- **Human-in-the-loop workflows.** A turn pauses on an approval gate and the session waits durably until the human responds; no held connection, no lost context.
- **Moving an agent across environments.** Start a session on a dev laptop and resume it on a VPS, a serverless function, or an edge isolate — same image, same journal, byte-identical behavior.
- **Agents you need to audit or replay.** Every step is journaled, so you can inspect the exact decision/effect timeline, derive traces, and re-run a session deterministically.

If your agent is a short, stateless request → response call, you don't need Iris — its value is durability and portability of *state*.

## How Iris compares

Iris's two neighbors each made one simplifying trade. **Docker Agent** keeps agents portable by keeping them *stateless*. **Eve** keeps agents *stateful* by binding them to one opinionated host. Iris takes the unclaimed corner — **stateful *and* portable** — and pays for it by owning the durability engine.

| | Docker Agent | Eve | Iris |
|---|---|---|---|
| **Packages** | stateless agents | stateful agents | **stateful agents — *and* portable** |
| **A session is** | an ephemeral process | bound to its host | **a journal + a pinned image digest — data, not a process** |
| **Runs on** | any OCI host (statelessly) | one opinionated host | **any host with two narrow ports** — VPS · serverless · edge · in-memory |
| **Pause here, resume elsewhere** | n/a — stateless | n/a — host-bound | **✅ cross-host, byte-identical resume** |
| **Durability engine** | none | framework/host-native | **owned by Iris — the same journal/replay/snapshot code on every host** |
| **Deterministic replay** | — | — | **✅ a pure function of the journal, asserted on every step** |
| **Authoring** | declarative YAML | filesystem + TypeScript | **declarative Agentfile (JSON/YAML) — behavior referenced, never embedded** |
| **Tools** | MCP servers + built-ins | typed TypeScript functions | **referenced across a protocol boundary (MCP / gRPC / subprocess) — any language** |
| **Distribution** | OCI image — push/pull anywhere | project / host deploy | **content-addressed OCI image — push/pull anywhere; sessions migrate too** |
| **Recovery** | — | host-managed | **at-least-once + idempotency, checkpoint-before-effect** |

<sub>— marks a property outside that project's design center, not necessarily a hard limitation.</sub>

> Iris = Docker's portability + Eve's durability — minus both their trades.

## The agent is a directory

`iris init` scaffolds a project; `iris build` compiles it into an image.

```text
my-agent/
├── agent.yaml          # the Agentfile — declarative manifest (agent.json also works)
├── instructions.md     # the always-on system prompt (embedded by hash at build)
└── skills/             # procedures loaded on demand (embedded by hash)
    └── triage.md
```

Tools and connections aren't local files — the manifest **references** them by URI (`mcp://`, `grpc://`, `subprocess://`), because behavior lives across a protocol boundary, free to be written in any language:

```yaml
apiVersion: iris/v1
kind: Agent
name: my-agent
model: anthropic/claude-x
instructions: ./instructions.md
skills:
  - ./skills/triage.md
tools:
  - ref: mcp://search
  - ref: grpc://billing@^2
connections:
  - ref: mcp://crm
harness:
  bundle: default
  tactics:
    decideNext: iris/tool-loop@^1
requires:
  tool_locality: remote
  long_running: true
sandbox:
  backend: inmemory
  network: deny-all
```

(`agent.json` works too — identical fields, identical `imageDigest`.)

`build` validates loudly: an unknown `apiVersion`/`kind`, an inline-behavior field (`code`/`script`/`source`), or an unrecognized ref scheme is rejected (`subprocess://` also requires `local_subprocess: true` and rules out `tool_locality: "remote"`). The whole contract ships as a JSON Schema (draft 2020-12) — run **`iris schema`** for it, or see the **[Agentfile reference](docs/reference/agentfile.md)** for every field.

`iris build` resolves those refs, embeds content by hash, pins everything in a lockfile, and emits a content-addressed OCI layout — the thing you push, pull, and run:

```text
image/                  # OCI layout — push/pull anywhere
├── oci-layout
├── index.json          # → image manifest, addressed by digest
└── blobs/sha256/…      # Agentfile + instructions + skills + lockfile, each pinned
```

Both JSON and a strict YAML subset compile to the **same deterministic `imageDigest`**. A live session **holds** its pinned digest — redeploying the image never silently changes a running session; the only sanctioned change is a definition migration.

## Install

**Requires [Node.js](https://nodejs.org) ≥ 24.** No build step, zero runtime dependencies.

```sh
# run it without installing anything
npx iris-runtime init my-agent

# …or install the `iris` command globally
npm i -g iris-runtime
iris init my-agent
```

The npm package is **`iris-runtime`**; the installed binary is **`iris`**. For a real model call, set a key — omit it and Iris uses a built-in deterministic fake:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Then head to the **[Quick start](#quick-start)**.

Working from a clone? See **[CONTRIBUTING](CONTRIBUTING.md)** for the install-free dev loop — `npm install` / `npm test` / `npm run typecheck`, and running the CLI straight from source with no build step.

## Quick start

From nothing to a running, resumable agent in **three steps** — no build step, no config, no API key required.

**1 · Scaffold a project**

```sh
npx iris-runtime init ./my-agent
```

Drops a self-contained agent on disk: `agent.yaml` + `instructions.md` + a working bundled `now` tool. (Prefer JSON? `iris init ./my-agent --json`.)

**2 · Build it into an image**

```sh
iris build --out ./image   # run from ./my-agent, or pass --file; auto-detects agent.yaml/json
# → {"imageDigest":"sha256:…"}
```

`build` resolves and hashes everything into a content-addressed OCI image — the single unit you version, push to any registry, and run anywhere.

**3 · Talk to it**

```sh
iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
```

`--fake` uses a deterministic echo model, so this runs with **no API key**. The conversation *is* the session journal: leave with `/exit`, rerun the exact same command, and the chat resumes where you left off.

> **Want a real model?** `export ANTHROPIC_API_KEY=sk-ant-…` then drop `--fake`.

That's the core loop. The rest of the command surface is below.

<details>
<summary><b>The full lifecycle — every command</b></summary>

`init → build → inspect → schema → providers → verify → run → serve/chat → deploy → audit/eval/schedule → journal`

```sh
iris init    ./my-agent                                   # scaffold a project: agent.yaml + instructions.md + a bundled `now` tool (--json for JSON)
iris build   --file ./my-agent/agent.yaml --out ./image   # → {"imageDigest":"sha256:…"} (auto-detects when --file is omitted)
iris inspect ./image                                      # read the image at the intent level
iris schema  > agentfile.schema.json                      # emit the Agentfile JSON Schema (draft 2020-12) for editor/CI
iris verify  ./image                                      # loud failure on any tamper or pin mismatch
iris run     ./image --session s1 --db /tmp/s1.sqlite     # run one turn (real model call — needs ANTHROPIC_API_KEY)
iris serve   ./image --port 8787 --web                    # HTTP server: REST + SSE + WS streaming, + a web chat UI at /
iris chat    ./image --session s1 --db /tmp/s1.sqlite     # durable, resumable, streaming chat
iris deploy  ./image --out ./iris-edge                    # scaffold a Cloudflare Worker + Durable Object for edge deploy
```

`audit`, `eval`, and `schedule` round out the surface. Declare secrets/env in the
Agentfile and pass them at run time with `--env-file` / `--env` (or `--secret-files`
for file-mounted secrets) — see [Tools → Secrets & environment](docs/tools.md).

**Running from a clone** (no published package, no build step) — swap `iris` for the source bin:
`node --conditions=iris-src packages/cli/src/cli-main.ts <cmd> …`

</details>

### Chat with it

A terminal REPL where you talk to the agent turn-by-turn. Replies **stream live**, token by token. Because the conversation *is* the journal, a brand-new process resumes the same chat — earlier turns are not re-streamed.

```sh
# No key needed — --fake is the deterministic echo model.
printf 'hello\nwhat can you do?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:hello              ← streamed token-by-token
# agent> echo:what can you do?

# A BRAND-NEW process resumes the SAME conversation:
printf 'still there?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:still there?       ← turn 3; earlier turns are NOT re-streamed
```

- **Real model** — drop `--fake`, set `ANTHROPIC_API_KEY`. A provider error surfaces as the reply, never poisons the session.
- **Durability** — `--db :memory:` for throwaway, a file path to persist.
- **Human-in-the-loop** — at an irreversible tool, chat parks and asks inline (`approve? [y/n]`), recorded as a journaled, replayable decision ([governance](docs/governance.md)).

### Serve it over HTTP

One command turns the image into an HTTP server — buffered REST plus a **live token stream** over SSE or WebSocket. Defaults to the no-key echo model; add `--model anthropic` + `ANTHROPIC_API_KEY` for the real provider.

```sh
iris serve ./image --port 8787
# → listening on http://127.0.0.1:8787 (model=echo)

# Stream a turn as Server-Sent Events:
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:8787/v1/session
# event: delta    data: {"type":"delta","text":"echo:"}
# event: outcome  data: {"type":"outcome","status":"parked","continuationToken":"…"}
```

Drop the `Accept` header for one buffered JSON reply, or hold a whole conversation over one WebSocket at `ws://…/v1/ws`. To continue a session, present the rotated single-use `continuationToken` — a stale or missing one is refused loudly (4xx), never a silent 200.

### Resume on a *different* host

The install-free portability proof: the **same image** starts on host A (sqlite, long-running), parks at a human-in-the-loop boundary, and resumes on host B (serverless-style, no held process) — same journal, byte-identical output.

```sh
node --conditions=iris-src examples/portability-demo.ts        # prints the proof, exits 0 on PASS
```

```text
① host A (vps-sqlite): turn ran → parked on HITL
② host A crossed a real snapshot+truncate boundary — migration is non-vacuous
③ migrateSession A→B: snapshot + journal tail copied to serverless-fs (port-only)
④ host B (serverless-fs): resumed from the SAME journal → finished (assertion green)
⑤ host-B state + output are BYTE-IDENTICAL to a single-host control
```

Regression-locked by `tests/cross-host-resume.test.ts`.

## Where a session can run

The same image runs on any host that implements the two ports. Each adapter enforces the *same* CAS / fencing / high-water-mark / snapshot invariants — only the storage and wakeup mechanics differ. A session can be `migrateSession`'d between any two of them and resumes byte-identically.

| Host target | Package | Shape | Wakeup |
|---|---|---|---|
| **VPS / long-running** | `@irisrun/store-sqlite` | One process holds the DB handle | SQLite durable timer |
| **Serverless** | `@irisrun/store-fs` | Cold per turn — no held process; a fresh instance over the same root resumes | filesystem timer (O_EXCL) |
| **Edge isolate** | `@irisrun/store-do` | Cold Durable-Object isolate per turn | DO alarm |
| **In-memory** | `@irisrun/store-memory` | Unit/test store + store **B** for cross-store resume | in-memory timer |

`@irisrun/host` adds the deploy gate: an Agentfile declares what it `requires`; a host declares its `capabilities`; an over-capable request is refused **loudly** at deploy, never silently downgraded.

## How it works

```text
                               client
                                  │
                                  ▼
┌────────────────  channel · REST · SSE · WS · MCP  ─────────────────┐
└─────────────────────────────────┬──────────────────────────────────┘
                                  ▼
╔══════════════════════  @irisrun/core · pure  ══════════════════════╗
║  harness kernel → seams → tactics  (default / coding bundle)       ║
║  effect engine → checkpoint-before-effect                          ║
║  journal → replay + always-on assertion → snapshot                 ║
╚════════════════╤══════════════════════════════════╤════════════════╝
                 │ StateStore (CAS + fencing)       │ Scheduler (wakeup)
                 ▼                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  host adapters    sqlite · fs · durable-objects · memory           │
└────────────────────────────────────────────────────────────────────┘

   channel protocol:  stable sessionId  +  single-use continuationToken (rotated per turn)
   tools across a protocol boundary:  in-process · subprocess · mcp · grpc
```

- **Durability engine.** An append-only journal of *effects* and *decisions* is the single source of truth. Each effect is checkpointed before it runs and read back on replay (a deterministic `effectId` means a recovered crash applies it at most once). The `StateStore` port is compare-and-swap + fencing, so only one writer ever wins; snapshots periodically materialize state and truncate the journal to keep replay cost bounded.
- **Tools across a protocol boundary.** A tool's **contract** (name + schema + transport) is its stable, model-visible identity, pinned by digest; the implementation floats behind it, in any language. Transports ship for in-process, `subprocess://`, `mcp://` (stdio JSON-RPC), and `grpc://` (http2 + JSON). Only an explicitly retry-safe tool gets an idempotency key, so recovery never double-writes.
- **Pluggable harness.** Each seam consultation *is* a journaled effect (`{seam, tacticId, choice}`), so a tactic can be nondeterministic or third-party and replay still cannot diverge. The **default bundle** covers most agents; `@irisrun/bundle-coding` adds coding-specialized tactics.
- **Channels & observability.** A channel owns the two-identifier protocol — a stable `sessionId` plus a single-use `continuationToken` rotated every turn — and streams a turn live over SSE or WebSocket (`iris serve`; `--web` adds the chat UI). `@irisrun/inspect`, `@irisrun/observe`, and `@irisrun/evals` are read-only journal derivations (timeline, OTel spans, reproducible evals), so they can't affect determinism.

## What's inside

A monorepo (npm workspaces). The **pure core** imports nothing host/transport/Node-specific; everything else is a host-side adapter or tool, each with **zero external dependencies**.

| Layer | Packages |
|---|---|
| **Core** | `@irisrun/core` — the pure durability engine: journal, replay + the always-on assertion, lease/fencing, recovery, snapshot/migrate, the two ports, and the harness kernel. |
| **Host adapters** | `store-sqlite` · `store-fs` · `store-memory` · `store-do` · `store-postgres` · `store-mysql` · `store-redis` · `store-mongo` (+ `@irisrun/host`) — long-running · serverless · in-memory · edge · SQL · KV · document, behind the `StateStore`/`Scheduler` ports (each certified by `@irisrun/store-conformance`; the DB driver is a peer dependency). |
| **The agent image** | `@irisrun/agent` (Agentfile → content-addressed OCI image) · `@irisrun/tools` (the tool boundary) · `@irisrun/sandbox` (the security floor). |
| **Channels** | `channel-core` (the port) · `channel-rest` · `channel-mcp` · `channel-slack` · `channel-web` + `client-sdk`. **Platform bridges** (Discord · Telegram · Teams · WhatsApp · Twilio · Google Chat) ride the `@irisrun/bridge` SDK as reference adapters, pluggable by specifier with `iris bridge <module>`. |
| **Providers** | `provider-anthropic` · `provider-openai` behind one tested port · `provider-compat` (the matrix). |
| **On the journal** | `audit` · `inspect` · `observe` · `evals` · `journal-export` · `subagents` · `schedule` · `auth` — read-only derivations + governance. |
| **CLI** | `iris-runtime` — the `iris` binary over all of it. |

The full per-package taxonomy is the **[architecture map](docs/architecture.md)**.

## Tested & proven

The unit suite is **install-free, deterministic, zero-dependency** — **1045 passing** on Node 24 (plus **6** live-provider conformance tests gated on API keys), `tsc --noEmit` clean. Every claim here is regression-locked:

- **Durability** — CAS + fencing; park/resume across a forced restart; the crash matrix (at-least-once, never double-applied).
- **Determinism** — replay purity asserted on every step (`IRIS_ASSERT=0` turns it off); a **10,000-session** determinism run; cross-store and **cross-host** resume.
- **Resilience** — a chaos/concurrency suite, a simulated partition, and redeploy-recovery against the real fs + sqlite backends.
- **Security** — an adversarial sandbox-egress [threat model](docs/reference/security-sandbox-threat-model.md) (bypass + secret-leak attempts).
- **Providers** — canonicalization + the conformance-verified compatibility matrix + model-call record-replay fidelity.
- **Channels** — the channel-port conformance suite (three channels behind one port); Slack durable-HITL across a redeploy; the single-use-token discipline; SSE/WebSocket streaming.
- **Images** — a deterministic `imageDigest` + a loud `verify`.

Real *egress* — OCI pushes, live Anthropic calls, `wrangler deploy` / Lambda upload, `npm publish`, OTLP export — stays **env-gated** as smoke tests under `tests/smoke/`, outside the suite.

```sh
npm test                                 # the whole suite → 1045 passing (6 live-conformance tests gated on API keys)
node --conditions=iris-src examples/portability-demo.ts          # the cross-host proof (install-free)
node tests/smoke/serverless-deploy-smoke.ts   # real Cloudflare DO / Lambda (gated)
IRIS_SERVE_SMOKE=1 node tests/smoke/serve-streaming-smoke.ts  # real serve: REST + SSE + WS (gated)
IRIS_PACK_SMOKE=1 node tests/smoke/npm-pack-smoke.ts          # npx iris-runtime init (gated)
```

Iris is **early** — `0.2.0`, [published on npm](https://www.npmjs.com/package/iris-runtime), public API still in flux — but the architecture and the install-free local/test path are production-minded. Cutting a release is gated (`IRIS_PUBLISH=1 npm run release`; see [`RELEASING.md`](RELEASING.md)).

## License

[MIT](LICENSE) © 2026 xoai
