# Iris docs

The [README](../README.md) is the manifesto — *why* Iris exists. These docs are the
**how**: a path from nothing to a deployed agent a real person can talk to, that
survives a host migration.

> **North star:** from `npx iris-runtime init` to a **deployed, talkable agent that
> survives a host migration** — in an afternoon, starting with **no API key**.

## Running the commands first

Every page writes `iris <cmd>`. That's `npx iris-runtime <cmd>` (or `npm i -g
iris-runtime`). Working from a clone instead — no install, no build step — run the bin
with the dev resolution condition:

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts <cmd>
```

Substitute whichever form you use. (The same `--conditions=iris-src` runs the in-repo
demos directly, e.g. `node --conditions=iris-src examples/portability-demo.ts`.)

## Getting started

Follow these in order — each ends with a **Next →** to the next stop.

1. [Introduction](./introduction.md) — what Iris is, and the one idea (a session is a
   journal) everything else follows from.
2. [Your first agent](./first-agent.md) — `init → build → chat` a **durable session you
   own**, with no API key; then a real model, and resume it across a restart.
3. [Tools](./tools.md) — tools as **versioned contracts referenced by address**, every
   call journaled for replay: the bundled `now` tool and the tool boundary.
4. [Channels](./channels.md) — **durable, resumable sessions** in the browser: serve over
   HTTP (SSE / WebSocket), the web chat UI, the client SDK; survive a tab close.
5. [Deploy](./deploy.md) — the headline: **resume the same session on a *different*
   host** — one command to a Cloudflare Durable Object.

## Concepts

How the runtime works, page by page.

- [Stores — durability backends](./stores.md) — where a session's journal lives: pick &
  plug a store (SQLite · Postgres · MySQL · Redis · Mongo · fs · edge) by name or module
  specifier, all behind one conformance-certified `StateStore`/`Scheduler` port.
- [The harness](./harness.md) — the model↔tool loop as swappable **tactics** at five
  **seams**; every decision is journaled, so you re-shape how the agent thinks without
  losing deterministic replay.
- [Models & providers](./providers.md) — **vendor-neutral, replay-safe** model adapters:
  Anthropic and OpenAI behind one tested port; swap without touching the agent.
- [Governance & approvals](./governance.md) — the approval gate, the `@irisrun/auth`
  policy layer, and the journaled approval trail (`iris serve --policy`).
- [Audit & reproducible evals](./audit-and-evals.md) — `iris audit` for a replay-verified
  session trail, and provably reproducible evals (`iris eval`).
- [Verifiable portable journals](./verifiable-journal.md) — export a session to a
  content-addressed `*.irisjournal`, verify it with nothing but the file, migrate it.

## Guides

Add a capability when you need it.

- [Subagents](./guides/subagents.md) — durable **delegation**: a parent agent hands a
  sub-task to a child agent with its own session; the child's output is journaled in the
  parent, so the parent replays without re-running it.
- [Schedules](./guides/schedules.md) — **recurring jobs** as durable, replayable agents:
  each cycle parks on a timer; a host-side pump resumes the due ones (`iris schedule`).
- [Observability](./guides/observability.md) — OTel-shaped **spans derived from the
  journal** (`@irisrun/observe`); add tracing without touching replay.
- [Inspecting a session](./guides/inspect.md) — read back **what an agent actually did**:
  the deterministic decision/effect/marker timeline (`inspectSession`).
- [Frontend & the client SDK](./guides/frontend.md) — put an agent in front of users: the
  web chat UI (`iris serve --web`) and the isomorphic `@irisrun/client-sdk`.
- [Secrets & environment](./guides/secrets.md) — declare secret *names* in the Agentfile,
  supply *values* at run time (`--env-file` / `--secret-files`); least-privilege tool env.
- [Connecting external services](./guides/connections.md) — wire an **external tool**
  (MCP / gRPC / subprocess), get a **credential** to it safely, and **gate** the calls
  that touch reality: transports, secrets, and approvals in one place.
- [The sandbox](./guides/sandbox.md) — the **untrusted-code security floor**: deny-all
  egress and secrets brokered at the boundary; the library backends, plus an honest note
  on what isn't wired into the runtime yet.

## Use cases

End-to-end recipes that compose the guides above into something you'd actually ship.

- [Multi-agent teams](./guides/multi-agent-team.md) — an **orchestrator and its
  specialists**: build a marketing team where a coordinator delegates to researcher /
  copywriter / editor child agents, each its own durable session.
- [Coding team](./guides/coding-team.md) — a full-stack **PM / Engineer / QC** team on
  three different models (Opus plans · Kimi codes · gpt reviews), sharing **Postgres**
  durability and an **mem0 MCP memory**, reachable from **Telegram**.
- [Autoresearch loop](./guides/autoresearch-loop.md) — an agent that **iterates,
  delegates, and converges**, in-session or on a schedule — plus how to set up an
  `iris eval` suite to regression-test the loop.
- [Automated workflow](./guides/automated-workflow.md) — run a multi-agent pipeline
  **unattended**, deployed two ways: Cloudflare Durable Objects, or self-hosted on any
  VPS (`iris serve` / `iris schedule`, in your own container).
- [Human-in-the-loop](./guides/human-in-the-loop.md) — **approvals that wait**: pause a
  risky step for a human decision over REST or Slack, for days, and resume the exact
  session.
- [Run on any provider](./guides/any-provider.md) — **one image, any endpoint**: point a
  portable agent at Anthropic/OpenAI, a gateway (Groq, Together, …), or a local model
  (Ollama, vLLM) at deploy time; know which are replay-safe (`iris providers --matrix`).
- [Never-lose-state agent](./guides/portable-durable-agent.md) — **crash, restart,
  migrate**: pick a durable store and the session resumes byte-for-byte; export and move
  it to another host with `iris journal`.
- [Auditable agent](./guides/auditable-agent.md) — **prove what it did**: a
  replay-verified, tamper-evident record from the same journal (`iris audit`), portable
  for anyone to re-verify.

## Reference

Normative specs and lookups, in [`reference/`](./reference/):

- [Agentfile reference](./reference/agentfile.md) — every Agentfile field, the JSON form, and the build-time validation rules.
- [CLI](./reference/cli.md) — every `iris <cmd>` with its flags, in one place.
- [Harness seams](./reference/harness-seams.md) — the normative tactic/bundle contract:
  the five seam signatures, composition rules, and the journaled `{seam, tacticId, choice}`.
- [Channel-port spec](./reference/channel-port-spec.md) — the contract every channel
  passes (two-identifier protocol, token rotation, refusal taxonomy, conformance).
- [Bridge pattern](./reference/bridge-pattern.md) — reaching Discord · Telegram · Teams ·
  WhatsApp · Twilio · Google Chat as external bridges (not first-party packages), with
  worked examples and the plug-and-play `iris bridge <module>` loader.
- [Verifiable-journal format](./reference/verifiable-journal-spec.md) — the
  content-addressed export format, reproducible in any language from the document alone.
- [Journal threat model](./reference/threat-model.md) — what journal verification detects
  (tamper / reorder / truncate) and what it deliberately does not claim.
- [Sandbox-egress threat model](./reference/security-sandbox-threat-model.md) — the
  egress firewall + credential broker: the deny-all floor, the host allowlist, the limits.

## Contributing

Start with **[CONTRIBUTING](../CONTRIBUTING.md)** — the dev loop (install-free,
`npm test` / `npm run typecheck`), the CI gate, and the house rules. Then:

- [Architecture](./architecture.md) — how the ~33 packages fit: the pure core, the two
  host ports (`StateStore` / `Scheduler`), and the adapter layers.
- [Conventions](./conventions.md) — the enforced house rules (core-is-pure, zero-dep,
  loud-refusal, tests-first).
- [Adapter SDK](./sdk.md) — **one dependency** (`@irisrun/sdk`) to build a store, channel, or
  provider adapter: the port types, the conformance suites, the `openStore` / `openModelProvider` /
  `openChannel` contracts, plus `iris adapter init` to scaffold and `--store` / `--provider` /
  `--channel <module>` to load without a fork.
- Extension recipes, each with a conformance suite that defines "done":
  [add a provider](./contributing/adding-a-provider.md) ·
  [add a channel](./contributing/adding-a-channel.md) ·
  [add a store](./contributing/adding-a-store.md) ·
  [add a tactic](./contributing/adding-a-tactic.md).

**Next → [Introduction](./introduction.md)**
