# Iris for agents

How an AI agent or tool discovers and integrates with Iris. Human docs:
[docs/](docs/README.md). Machine index: [llms.txt](llms.txt).

## What Iris is

A portable durability runtime for stateful agents. An agent is a declarative
**Agentfile** (`agent.yaml` / `agent.json`) plus a folder; `iris build` compiles it into
a content-addressed image. At runtime a session is an **event-sourced journal**: every
model call, tool result, and timer is recorded, and replay reads the recorded result
instead of re-invoking it — so a session is durable, deterministic on replay, and
portable across hosts.

## Surfaces you can use

- **Agentfile schema** — `iris schema` prints the authoritative JSON Schema
  (draft 2020-12) for the Agentfile; use it for validation and editor autocomplete.
  See [Tools](docs/tools.md) and [Introduction](docs/introduction.md).
- **MCP server** — `@irisrun/channel-mcp` exposes an Iris agent *as* an MCP server over
  JSON-RPC 2.0 (stdio): call the `start` tool to begin a session and `message` to
  continue it, presenting the rotated single-use `continuationToken` each turn.
  See [Channels](docs/channels.md).
- **REST API** — `iris serve` exposes the two-identifier HTTP protocol
  (`POST /v1/session` to start, `POST /v1/session/{sessionId}/message` to continue) with
  SSE / WebSocket streaming. See [Channels](docs/channels.md) and the normative
  [channel-port spec](docs/reference/channel-port-spec.md).
- **Tools as contracts** — tools are referenced by address (`mcp://`, `grpc://`,
  `subprocess://`), never embedded, so they can be written in any language.
  See [Tools](docs/tools.md).

## Conventions

- Commands: `npx iris-runtime <cmd>` (installed) or, from a clone,
  `node --conditions=iris-src packages/cli/src/cli-main.ts <cmd>`.
- Effects are journaled and replay deterministically — recorded results are replayed,
  never re-run. Verification and audit work from the journal alone.
