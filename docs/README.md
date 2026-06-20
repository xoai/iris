# Iris docs — the guided path

The [README](../README.md) is the manifesto: it tells you *why* Iris exists. This
is the **funnel**: a path a stranger can follow, in order, from nothing to a
deployed agent a real person can talk to.

> **North star:** from `npx iris init` to a **deployed, talkable agent that
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
   `@iris/auth` governance layer, and the journaled approval trail.
8. [08 — Audit & reproducible evals](./08-audit-and-evals.md) — the headline:
   `iris audit` for a replay-verified, compliance-grade session trail, and
   provably reproducible evals. Determinism → reproducible evals → audit.

## How to run the commands

Once Iris is published, the `iris` command is just `npx iris <cmd>` (or
`npm i -g iris`). Working from a clone before publish, run the bin from the
workspace with the dev resolution condition (no build step):

```sh
node --conditions=iris-src packages/cli/src/cli-main.ts <cmd> …
```

Every page below writes `iris <cmd>` for brevity; substitute whichever form you
are using.

**Next → [01 — Introduction](./01-introduction.md)**
