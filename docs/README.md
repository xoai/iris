# Iris docs — the guided path

The [README](../README.md) is the manifesto: it tells you *why* Iris exists. This
is the **funnel**: a path a stranger can follow, in order, from nothing to a
deployed agent a real person can talk to.

> **North star:** from `npx iris-runtime init` to a **deployed, talkable agent that
> survives a host migration** — in an afternoon.

Follow these in order. Each page ends with a **Next →** link to the next stop.

1. [01 — Introduction](./01-introduction.md) — what Iris is, and the one idea
   (a session is a journal) everything else follows from.
2. [02 — Your first agent](./02-first-agent.md) — build a **durable session you
   own**: `init → build → chat` with no API key, then a real model, and resume it
   across a restart.
3. [03 — Tools](./03-tools.md) — tools as **versioned contracts you own**, every
   call journaled for replay: the bundled `now` tool, the tool boundary
   (in-process → subprocess → MCP → gRPC), and **secrets & environment** declared
   in the Agentfile and injected at run time (least-privilege; `--env-file` /
   `--secret-files`).
4. [04 — Channels](./04-channels.md) — **durable, resumable sessions** in the
   browser: serve over HTTP (SSE / WebSocket), the web chat UI, and the client
   SDK; survive a tab close. The [channel-port spec](./reference/channel-port-spec.md) is the
   normative contract every channel passes; other platforms are
   [bridges](./reference/bridge-pattern.md), not packages.
5. [05 — Deploy](./05-deploy.md) — the headline: **resume the same session on a
   *different* host** — one command to a Cloudflare Durable Object.
6. [06 — Models & providers](./06-providers.md) — **vendor-neutral, replay-safe
   model adapters**: Anthropic and OpenAI behind one tested port (swap without
   touching the agent); how to add a third.
7. [07 — Governance & audit](./07-governance.md) — the approval gate, the
   `@irisrun/auth` governance layer, and the journaled approval trail — turned on
   from the CLI with `iris serve --policy`.
8. [08 — Audit & reproducible evals](./08-audit-and-evals.md) — the headline:
   `iris audit` for a replay-verified, compliance-grade session trail, and
   provably reproducible evals (`iris eval`). Determinism → reproducible evals →
   audit. Plus subagent delegation (`subagents.json`) and recurring schedules
   (`iris schedule`) on the same journaled substrate.
9. [09 — Verifiable portable journals](./09-verifiable-journal.md) — the proof:
   export a session to a content-addressed `*.irisjournal` file, verify it with
   nothing but the file (`iris journal verify`), and migrate it across hosts.
   The [format spec](./reference/verifiable-journal-spec.md) and
   [threat model](./reference/threat-model.md) make the moat externally legible.

## Reference

Normative specs and threat models — referenced from the funnel above, collected here
and living under [`reference/`](./reference/):

- [Channel-port spec](./reference/channel-port-spec.md) — the contract every channel
  passes (the two-identifier protocol, token rotation, refusal taxonomy, conformance).
- [Bridge pattern](./reference/bridge-pattern.md) — reaching Discord / Telegram /
  Teams / etc. as external bridges (not first-party packages), with worked examples.
- [Verifiable-journal format spec](./reference/verifiable-journal-spec.md) — the
  content-addressed export format; reproducible in any language from the document alone.
- [Journal threat model](./reference/threat-model.md) — what journal verification
  detects (tamper / reorder / truncate) and what it deliberately does not claim.
- [Sandbox egress threat model](./reference/security-sandbox-threat-model.md) — the
  adversarial review of the egress firewall + credential broker: what the deny-all
  floor, the host allowlist, and credential brokering guarantee, how each is proven,
  and the honest limits.

## How to run the commands

The `iris` command is `npx iris-runtime <cmd>` (or `npm i -g iris-runtime`).
Working from a clone instead (no install), run the bin from the workspace with the
dev resolution condition (no build step):

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts <cmd> …
```

Every page below writes `iris <cmd>` for brevity; substitute whichever form you
are using.

**Next → [01 — Introduction](./01-introduction.md)**
