# Iris

![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success) ![tests](https://img.shields.io/badge/tests-340%2F340-success) ![license](https://img.shields.io/badge/license-MIT-blue)

**Build agents in a folder. Run them anywhere. Never lose a session.**

Iris is a portable runtime for durable AI agents — built so an agent is never locked to a single host, model, or vendor. You declare an agent as a config file plus a folder (instructions, tools, skills, channels), and `iris build` compiles it into an open, content-addressed image: the unit you version, push to any OCI registry, and run anywhere.

At runtime, a session is an event-sourced journal — every model call, tool result, and timer is checkpointed *before* it runs, so live state is a deterministic replay of the log, not a process you hold open. That makes a session durable across crashes **and portable across hosts**: pause it on a VPS, resume it in a serverless function or an edge isolate, mid-task and byte-for-byte identical, against any LLM and over any channel. The harness ships with it — tool-calling, human-in-the-loop gates, context compaction, idempotent retries, resumable long-running work — and every decision is journaled, so replay never diverges.

**[Features](#key-features)** · **[When to use](#when-to-use-iris)** · **[Compare](#how-iris-compares)** · **[Authoring](#the-agent-is-a-directory)** · **[Install](#install)** · **[Quick start](#quick-start)** · **[How it works](#how-it-works)** · **[Packages](#whats-inside)** · **[Status](#status)**

## Key features

- **Pause and resume anywhere** — one agent image runs on a laptop, a VPS, a serverless function, or an edge isolate. Stop a session on one and resume it on another, mid-task.
- **You own the state, not the host** — the agent's progress lives in Iris's log, not in a host's memory. The same journal / replay / snapshot code runs everywhere; a host only has to store bytes and wake the agent up.
- **It can't silently drift** — replaying the log always rebuilds the exact same state, and Iris checks this on every step. If a crash interrupts an action, recovery retries it safely (at-least-once with idempotency) — never twice.
- **Config, not code** — describe the agent in a small `Agentfile` (JSON or YAML). Tools live outside the agent and are referenced by address (MCP / gRPC / subprocess), so they can be written in any language and run on any host.
- **Ships like a Docker image** — `iris build` produces a content-addressed image you can `inspect` and `verify`, then **push to any OCI registry and pull and run anywhere**.
- **Bring your own model** — the model call is just another recorded step behind a small adapter. An Anthropic adapter ships; others drop in. No provider is baked into the core.
- **A small, safe core you can extend** — a thin kernel enforces the safety rules; the agent's decisions (when to summarize context, when to stop, when to ask a human) are pluggable, and every choice is recorded so replay stays exact.
- **Secure by default** — tools run sandboxed with networking denied by default, and credentials are brokered so secrets never enter the sandbox.

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

**Only Iris:**

- **Resumes a live session on a different substrate** — start on a VPS, finish on a serverless function or an edge isolate, from the same journal, byte-for-byte identical.
- **Owns the durability engine** — journal / replay / snapshot is Iris's code, identical everywhere; a host supplies only a compare-and-swap store and a wakeup.
- **Proves its own determinism** — replay is a pure function of the journal, and an always-on assertion trips the moment any nondeterminism is introduced.
- **Is stateful, portable, *and* OCI-distributed at once** — Docker's distribution model and Eve's statefulness, without either's trade.

> Iris = Docker's portability + Eve's durability — minus both their trades.

## The agent is a directory

`iris init` scaffolds a project; `iris build` compiles it into an image.

```text
my-agent/
├── agent.json          # the Agentfile — declarative manifest (agent.yaml also works)
├── instructions.md     # the always-on system prompt (embedded by hash at build)
└── skills/             # procedures loaded on demand (embedded by hash)
    └── triage.md
```

Tools and connections aren't local files — the manifest **references** them by URI, because behavior lives across a protocol boundary:

```json
{
  "apiVersion": "iris/v1",
  "kind": "Agent",
  "name": "my-agent",
  "model": "anthropic/claude-x",
  "instructions": "./instructions.md",
  "skills": ["./skills/triage.md"],
  "tools": [{ "ref": "mcp://search" }, { "ref": "grpc://billing@^2" }],
  "connections": [{ "ref": "mcp://crm" }],
  "harness": {
    "bundle": "default",
    "tactics": { "decideNext": "iris/tool-loop@^1" }
  },
  "requires": {
    "tool_locality": "remote",
    "long_running": true
  },
  "sandbox": {
    "backend": "inmemory",
    "network": "deny-all"
  }
}
```

Every field, and what it controls:

| Field | Required | Values / form | What it does |
|---|---|---|---|
| `apiVersion` | yes | `"iris/v1"` | Schema version (only value today). |
| `kind` | yes | `"Agent"` | Manifest kind. |
| `name` | yes | string | The agent's name. |
| `model` | yes | `"<provider>/<model>"` | What the `model_call` performer resolves, e.g. `anthropic/claude-x`. |
| `instructions` | yes | path | Always-on system prompt — **content embedded by hash** at build. |
| `skills` | yes (may be `[]`) | path[] | Procedures loaded on demand; embedded by hash. |
| `tools` | yes (may be `[]`) | `{ ref }[]` | Tool contracts referenced by URI — `mcp://`, `grpc://`, or `subprocess://` (version range allowed, e.g. `@^2`). Pinned by digest. |
| `connections` | yes (may be `[]`) | `{ ref }[]` | Long-lived connections; same ref schemes as `tools`. |
| `harness.bundle` | no | bundle ref | The tactic bundle — `"default"`, or a domain bundle (e.g. the coding bundle). |
| `harness.tactics` | no | `{ seam: ref }` | Per-seam tactic overrides (seams include `assembleContext`, `decideNext`, `onToolError`, `shouldCompact`, `gateAction`). |
| `requires.tool_locality` | no | `in-process` \| `local` \| `remote` | Where tools may run; checked against the host at deploy. |
| `requires.long_running` | no | bool | Needs a host that holds a live process. |
| `requires.local_subprocess` | no | bool | Must be `true` for any `subprocess://` tool. |
| `requires.filesystem` | no | bool | Needs host filesystem access. |
| `requires.websockets` | no | bool | Needs WebSocket channels. |
| `sandbox.backend` | yes | `inmemory` \| `docker` | Sandbox backend for tool execution. |
| `sandbox.network` | yes | e.g. `deny-all` | Network policy floor. |
| `sandbox.workspace` | no | path | A workspace directory, embedded by hash. |

`build` validates the manifest loudly: an unknown `apiVersion`/`kind`, an inline-behavior field (`code`/`script`/`source`), or a non-`mcp`/`grpc`/`subprocess` ref is rejected — and a `subprocess://` tool requires `local_subprocess: true` and is incompatible with `tool_locality: "remote"`.

> Where Eve keeps tools as local TypeScript, Iris references them across a protocol boundary — *language-agnostic by exile*. The price is a serialize-and-transport hop; the payoff is that a tool can live in any language, in-process or across the network, while one stable contract pins it by digest.

`iris build` resolves those refs, embeds content by hash, pins everything in a lockfile, and emits a content-addressed OCI layout — the thing you push, pull, and run:

```text
image/                  # OCI layout — push/pull anywhere
├── oci-layout
├── index.json          # → image manifest, addressed by digest
└── blobs/sha256/…      # Agentfile + instructions + skills + lockfile, each pinned
```

Both JSON and a strict YAML subset compile to the **same deterministic `imageDigest`**. A live session **holds** its pinned digest — redeploying the image never silently changes a running session; the only sanctioned change is a definition migration.

## Install

Iris runs on **Node.js ≥ 24** with **zero runtime dependencies** — TypeScript executes directly via Node's native type-stripping, so there is **no build step**. `node:sqlite`, `node:fs`, `node:http(2)`, and `node:test` are all built in.

```sh
# from the repository root
npm install            # links local workspaces (offline; nothing to fetch at runtime)
npm test               # node --test 'tests/**/*.test.ts'  → 340/340
npm run typecheck      # tsc --noEmit  (optional; passes clean)
```

The `iris` command is the `@iris/cli` workspace bin. Set a model key for the real path (tests use a deterministic fake and need none):

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

> Use the **glob** form `node --test 'tests/**/*.test.ts'` (what `npm test` runs); a bare directory fails on Node 24. `node:sqlite` prints a cosmetic `ExperimentalWarning`.

## Quick start

Build an image, look inside it, and run a session — the lifecycle is `init → build → inspect → verify → run`:

```sh
iris init    ./my-agent                                   # scaffold agent.json + instructions.md
iris build   --file ./my-agent/agent.json --out ./image   # → {"imageDigest":"sha256:…"}
iris inspect ./image                                      # the image at the intent level
iris verify  ./image                                      # loud failure on any tamper or pin mismatch
iris run     ./image --session s1 --db /tmp/s1.sqlite     # run a turn under the session's held pin
iris serve   ./image --port 8787                          # turnkey HTTP server: REST + SSE + WS streaming
iris chat    ./image --session s1 --db /tmp/s1.sqlite     # talk to the agent — durable, resumable, streaming chat
```

(Before `npm link`, invoke the bin directly: `node packages/cli/src/cli-main.ts <cmd> …`.) `iris run` performs a real model call, so it needs `ANTHROPIC_API_KEY` — for a no-key run, use the demo below. `iris serve` defaults to a **no-key echo model** (set `--model anthropic` with a key for the real provider), so streaming is demoable immediately: `POST /v1/session` (add `Accept: text/event-stream` for SSE), `POST /v1/session/<id>/message` to continue, or connect a WebSocket to `ws://<host>/v1/ws`.

### A minimal example — park and resume across a real restart

No model needed. The bundled demo runs one turn, parks on a durable timer, exits — then a **fresh process** rehydrates purely from SQLite and finishes:

```sh
# 1. Run a turn — reads a logical clock, parks on a durable timer, exits.
node packages/demo/src/run.ts --session demo --db /tmp/iris-demo.sqlite
# → {"status":"parked","wait":{"kind":"timer","at":10}}

# 2. A brand-new process resumes from the SAME journal and finishes.
node packages/demo/src/run.ts --session demo --db /tmp/iris-demo.sqlite --resume --now 100
# → {"status":"finished","output":{"counter":2,"echoed":{"counter":1}}}
```

### Chat with an agent — a durable, resumable conversation

`iris chat` is the interactive client: a terminal REPL where you talk to an agent
turn-by-turn, the way `eve dev` lets you converse with one locally — except the
conversation **is** the session journal, so it survives the process and resumes
later (and, like any Iris session, can migrate across hosts mid-chat). Between
messages the session simply *parks* on a user wait; the next message resumes it.

Replies **stream live**, token by token, as the model produces them — each
`agent>` line fills in as the tokens arrive rather than appearing all at once
(the keyless `--fake` echo streams in word chunks, so you can see it without a
key). Streaming is a non-journaled side-channel: the durable journal still
records the whole reply, so resuming a session replays from the journal **without
re-streaming** earlier turns.

```sh
# No key needed: pass --fake to use the deterministic echo model (what the suite uses).
printf 'hello\nwhat can you do?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:hello              ← printed token-by-token as it streams
# agent> echo:what can you do?

# A BRAND-NEW process resumes the SAME conversation from /tmp/s1.sqlite:
printf 'still there?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:still there?      ← continues turn 3; earlier turns are NOT re-streamed
```

Set `ANTHROPIC_API_KEY` (and drop `--fake`) for real model replies — the chat
wraps the **streaming** model call with the image's model + instructions, and a
provider error surfaces as the agent's reply rather than poisoning the session.
`--db :memory:` works for a throwaway session; pass a file path to make it
durable. `/exit`, `/quit`, or Ctrl-D leaves; the session stays put. (An
in-terminal human-in-the-loop approval prompt is still on the roadmap.)

### Serve it over HTTP — SSE or WebSocket streaming

`iris serve` boots the same image as a one-command HTTP server: buffered REST
plus a **live token stream** over SSE or WebSocket. It defaults to the no-key
echo model (so it streams immediately); pass `--model anthropic` with
`ANTHROPIC_API_KEY` for the real provider.

```sh
iris serve ./image --port 8787
# → iris serve: listening on http://127.0.0.1:8787 (model=echo)

# Start a session and stream the turn as Server-Sent Events (Accept: text/event-stream):
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:8787/v1/session
# event: delta    data: {"type":"delta","text":"echo:"}      ← one event per model token
# event: delta    data: {"type":"delta","text":" hello"}
# event: outcome  data: {"type":"outcome","sessionId":"…","status":"parked","continuationToken":"…"}

# Continue the SAME session — present the rotated single-use token (a body field,
# or the x-continuation-token header). The path carries the minted sessionId:
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"continuationToken":"<token>","messages":[{"role":"user","content":"more"}]}' \
  http://127.0.0.1:8787/v1/session/<sessionId>/message
```

Drop `Accept: text/event-stream` for a single buffered JSON reply
(`{sessionId, continuationToken, status, …}`). A WebSocket client can hold one
connection for the whole conversation at `ws://127.0.0.1:8787/v1/ws` (same
`record` / `delta` / `outcome` event model, gated on the `websockets`
capability). The channel rotates the single-use `continuationToken` every
committed turn; a stale or missing token is refused loudly (4xx), never a silent
200.

### The headline — resume on a *different* host

The portability proof is install-free. The **same image** starts a session on host A (sqlite, long-running), parks at a turn boundary via human-in-the-loop, and resumes on host B (a serverless-style host that holds **no** long-lived handle) — from the same journal, with byte-identical output:

```sh
node manual/portability-demo.ts        # prints the proof, exits 0 on PASS
```

```text
① host A (vps-sqlite): turn ran → parked on HITL
② host A crossed a real snapshot+truncate boundary — the migration is non-vacuous
③ migrateSession A→B: snapshot + journal tail copied to serverless-fs (store-only, port-only)
④ host B (serverless-fs): resumed from the SAME journal → finished (replay assertion green)
⑤ host-B state + output are BYTE-IDENTICAL to a single-host control; the image pin is unchanged
```

It is regression-locked by `tests/cross-host-resume.test.ts`.

## Where a session can run

The same image runs on any host that implements the two ports. Each adapter enforces the *same* CAS / fencing / high-water-mark / snapshot invariants — only the storage and wakeup mechanics differ. A session can be `migrateSession`'d between any two of them and resumes byte-identically.

| Host target | Package | Shape | Wakeup |
|---|---|---|---|
| **VPS / long-running** | `@iris/store-sqlite` | One process holds the DB handle | SQLite durable timer |
| **Serverless** | `@iris/store-fs` | Cold per turn — no held process; a fresh instance over the same root resumes | filesystem timer (O_EXCL) |
| **Edge isolate** | `@iris/store-do` | Cold Durable-Object isolate per turn | DO alarm |
| **In-memory** | `@iris/store-memory` | Unit/test store + store **B** for cross-store resume | in-memory timer |

`@iris/host` adds the deploy gate: an Agentfile declares what it `requires`; a host declares its `capabilities`; an over-capable request is refused **loudly** at deploy, never silently downgraded.

## How it works

```text
        client ──▶  channel  (REST · SSE · WS · MCP — two-identifier protocol)
                       │
                       ▼
  ┌──────────────────────  @iris/core  (pure)  ──────────────────────┐
  │  harness kernel  →  seams  →  tactics (default / coding bundle)   │
  │  effect engine   →  checkpoint-before-effect                      │
  │  journal  →  replay + always-on assertion  →  snapshot            │
  └──────┬────────────────────────────────────────────────────┬──────┘
   StateStore (CAS + fencing)                          Scheduler (wakeup)
         │                                                     │
         ▼                                                     ▼
  host adapters:   sqlite  ·  fs  ·  durable-objects  ·  memory

  tools  ◀── protocol boundary ──▶  in-process · subprocess · mcp · grpc
```

- **Durability engine.** An append-only journal of *effects* and *decisions* is the single source of truth. Effects are checkpointed before they run and read back on replay (`effectId` is deterministic, so a recovered crash applies each effect at most once). The `StateStore` port is compare-and-swap + fencing — plain get/put can't guarantee single-writer safety. Snapshots periodically materialize state and truncate the journal so replay cost stays bounded.
- **Tools across the protocol boundary.** A tool's **contract** (name + schema + transport) is its stable, model-visible identity, pinned by digest; behavior floats behind it. Transports ship for **in-process**, **subprocess** (`subprocess://`), **MCP** (`mcp://`, stdio JSON-RPC), and **gRPC** (`grpc://`, over http2 + JSON). `tool_locality` is a host capability, not a fixed assumption. Only an explicitly retry-safe tool gets an idempotency key, so recovery never double-applies a write.
- **Pluggable harness.** A seam consultation *is* an effect — performed through the same path as a model call, its `{seam, tacticId, choice}` journaled — so a tactic may be nondeterministic or third-party and replay still cannot diverge. The shipped **default bundle** covers most agents; `@iris/bundle-coding` is the first domain bundle (read-only tools allow, writes + shell gate to *ask*, tool-loop `decideNext`, compaction + tool repair).
- **Channels.** A channel owns the **two-identifier protocol**: a stable `sessionId` to attach/inspect, and a `continuationToken` the channel mints, rotates every turn, and treats as atomically single-use — a stale or missing token is refused loudly (a 4xx over REST, a JSON-RPC error over MCP), never a silent 200. Ships for REST (`node:http`) and as an MCP server (stdio). The REST channel also **streams a turn live**: with `Accept: text/event-stream` it emits the committed journal records and the model's token deltas over **SSE**, then a terminal `outcome` event with the rotated token; the same event model rides a **WebSocket** (hand-rolled RFC 6455, zero-dep, gated on the `websockets` capability per ADR-0008). `iris serve` boots the whole thing as a one-command server.
- **Observability.** `@iris/inspect` renders the deterministic decision/effect/marker timeline; `@iris/observe` derives OTel-shaped spans with deterministic span ids; `@iris/evals` is a reproducibility arbiter (same case + scorer → byte-identical re-run; a swapped tactic scores differently but reproducibly). All three are read-only derivations over the journal, so they can't affect determinism.

## What's inside

A monorepo (npm workspaces). The **pure core** imports nothing host/transport/Node-specific; everything else is a host-side adapter or tool, each with **zero external dependencies**.

| Package | Role |
|---|---|
| `@iris/core` | The pure durability core — journal, the two ports, replay + the always-on assertion, the effect engine, lease/fencing, recovery, snapshot/`migrateSession`, **and** the harness kernel + seams + `defaultBundle`. |
| `@iris/store-sqlite` · `@iris/store-fs` · `@iris/store-memory` · `@iris/store-do` | The four host adapters — long-running (sqlite), serverless (fs, O_EXCL), in-memory, and edge (Durable Objects). |
| `@iris/host` | `HostAdapter` + `runTurnOn` + the capability-diff deploy gate. |
| `@iris/agent` | The image toolchain — Agentfile parse/validate, resolve/embed/pin, deterministic `imageDigest`, OCI layout, loud `verify`, session pinning + definition migration. |
| `@iris/cli` | The `iris` binary — `init / build / inspect / verify / push / pull / run / serve / chat`. `serve` boots a turnkey HTTP server (buffered REST + streaming SSE + WebSocket); `chat` is the interactive durable chat client. |
| `@iris/tools` | The tool boundary — contract + digest, the uniform invoker, in-process/subprocess/MCP/gRPC transports, the retry-safe `tool_call` performer. |
| `@iris/sandbox` | The security floor — deny-all network + credential brokering (inmemory; docker is a manual smoke). |
| `@iris/channel-rest` · `@iris/channel-mcp` | The channels — REST over `node:http` with live **SSE** and hand-rolled zero-dep **WebSocket** streaming of a turn (records + model token deltas), and the agent exposed *as* an MCP server. |
| `@iris/bundle-coding` | The first domain tactic bundle — coding-specialized seam tactics. |
| `@iris/inspect` · `@iris/observe` · `@iris/evals` | Read-only journal derivations — timeline viewer, OTel spans, reproducible-eval arbiter. |
| `@iris/provider-anthropic` | The `model_call` performer — a direct Anthropic Messages adapter via built-in `fetch`. |
| `@iris/demo` | The no-model counter machine that parks and resumes across a restart. |

## Tested & proven

The unit suite is install-free and deterministic — **340/340** on Node 24, `tsc --noEmit` clean — and every claim above is regression-locked: CAS + stale-fence rejection, park/resume across a forced restart, replay purity with the assertion catching injected nondeterminism, the crash matrix (at-least-once, no double-apply), snapshot equivalence, `model_call` as a journaled effect, **10,000-session** determinism, cross-store and **cross-host** resume, swap-tactic-live↔replay byte-identicality, deterministic image digest + loud verify, the channel single-use-token discipline, the streaming layer (the read-only `onRecord` observer preserves determinism, model deltas reconcile to the journaled result, rune-safe SSE parsing, and the hand-rolled WS frame codec), and the interactive durable chat client.

Real targets — Docker, a real OCI registry, a real Anthropic call, Cloudflare/Lambda deploys, OTLP export, external REST/WS/MCP/gRPC — are **manual smokes** under `manual/`, env-gated and outside the suite.

```sh
npm test                                 # the whole suite → 340/340
node manual/portability-demo.ts          # the cross-host proof (install-free)
node manual/serverless-deploy-smoke.ts   # real Cloudflare DO / Lambda (gated)
IRIS_SERVE_SMOKE=1 node manual/serve-streaming-smoke.ts  # real serve: REST + SSE + WS (gated)
```

## Status

Iris is early and moving fast (`v0.0.1`, not yet published to npm) — but the foundation is deliberately overbuilt. **Solid:** the install-free durability core — journal, replay, the always-on consistency assertion, recovery, snapshot, and cross-host migration — is covered by 290 deterministic tests (310/310 suite-wide with the interactive client), including a 10,000-session determinism run and a byte-identical cross-host resume.

**Still thin:** one model adapter ships (Anthropic) behind a provider-agnostic port; the channels (REST + SSE/WS streaming, MCP) and `iris serve` run install-free, but the real OCI registry, Cloudflare/Lambda, real-Anthropic, and reachable-socket serve paths are **manual smokes**, not yet a one-command deploy. Treat the architecture and the local/test path as production-minded, the breadth as in progress, and the public API as subject to change.

## Configuration

- `IRIS_ASSERT=0` disables the replay-consistency assertion (default: **on**). It's read by the runner/host and passed into the engine — `core/` **never** reads `process.env`.
- `ANTHROPIC_API_KEY` enables the real `model_call` path; without it, use the deterministic fake performer (what the suite does).
- Manual smokes are env-gated (e.g. `IRIS_EDGE_SMOKE` for the Cloudflare Workers smoke) and never run under `npm test`.

## License

[MIT](LICENSE) © 2026 xoai
