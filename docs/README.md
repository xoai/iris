# Iris docs — the guided path

The [README](../README.md) is the manifesto: it tells you *why* Iris exists. This
is the **funnel**: a path a stranger can follow, in order, from nothing to a
deployed agent a real person can talk to.

> **North star:** from `npx iris-runtime init` to a **deployed, talkable agent that
> survives a host migration** — in an afternoon.

Follow these in order. Each page ends with a **Next →** link to the next stop.

1. [01 — Introduction](./01-introduction.md) — what Iris is, and the one idea
   (a session is a journal) everything else follows from.
2. [02 — Your first agent](./02-first-agent.md) — `init → build → chat`. Talk to
   an agent with no API key, then with a real model. Resume it across a restart.
3. [03 — Tools](./03-tools.md) — the bundled `now` tool, how the agent calls it,
   and the tool boundary (in-process → subprocess → MCP → gRPC).
4. [04 — Channels](./04-channels.md) — serve over HTTP (SSE / WebSocket), the web
   chat UI, and the client SDK. Survive a tab close.
5. [05 — Deploy](./05-deploy.md) — one command to a Cloudflare Durable Object, and
   the headline: resume the same session on a *different* host.
6. [06 — Models & providers](./06-providers.md) — bring your own model. Anthropic
   and OpenAI behind one tested port; how to add a third.
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
   The [format spec](./verifiable-journal-spec.md) and
   [threat model](./threat-model.md) make the moat externally legible.

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
