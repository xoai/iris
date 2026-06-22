# Tools

A tool in Iris is a **versioned contract you own** — pinned into the image by
digest and invoked across a transport boundary, never inline code — and every
call the agent makes is a journaled effect, so a tool invocation **replays from
the log** instead of re-running. That's what keeps a tool-using agent portable
(the host decides how to reach each tool) and verifiable (the call is in the
journal). Iris ships your first project with a working tool, so a fresh agent
isn't an empty folder pointing at servers you'd have to build yourself.

## The bundled `now` tool

`iris init` scaffolds two files under `tools/`:

- `tools/now.mjs` — the tool implementation. It speaks a tiny line protocol over
  stdio (one JSON request in, one JSON response out) and returns the current time —
  the canonical "a language model can't know this" example.
- `tools/now.tool.json` — the tool **contract**: its name, description, and input
  schema. The agent perceives the contract; the runtime invokes the implementation.

When you `iris build`, the contract is pinned into the image by digest. When you
`iris chat` / `iris run` / `iris serve`, the CLI discovers the project's `tools/`
directory and wires a subprocess invoker, so the agent can call `now` and get a
real answer.

```sh
# the now tool is already wired — ask the agent for the time and it will call it
iris chat ./image --session t1 --db /tmp/t1.sqlite
```

(The default `tools/` dir is the sibling of the image layout; override it with
`--tools <dir>` on `run` / `chat` / `serve`.)

## Why a tool is a *contract*, not code

An Agentfile declares **what** a tool is (its contract), never **how** it runs
(no inline code/script/source — that's rejected at build). Behavior lives behind a
transport. This is what keeps an image portable: the same image runs anywhere,
and the host decides how to reach each tool.

## The tool boundary

Iris recognizes four transports, from closest to furthest:

| Transport | Where it runs | Use it for |
|---|---|---|
| **in-process** | same isolate | pure, trusted helpers |
| **subprocess** | a child process (what the scaffold uses) | local scripts/CLIs |
| **MCP** | a Model Context Protocol server | reusable, language-agnostic tools |
| **gRPC** | a remote service | networked capabilities |

A tool's locality is part of the image's declared capabilities, and the deploy gate
honors it — an edge host that supports only remote tools will **refuse** an image
that demands local subprocess tools, loudly, rather than silently degrade it (see
[Deploy](./deploy.md)).

**Wiring an MCP server.** An `mcp://` tool resolves at build time, but its server runs at
run time — map each one to a command in an `mcp.json` beside the image (`--mcp <file>`
overrides): `[{ "name": "<location-handle>", "command": "npx", "args": ["-y", "some-mcp"] }]`.
The `name` is the tool's location handle (the `mcp://` ref minus scheme, shown by
`iris inspect`), and the image's scoped tool env reaches the server — so an MCP memory like
mem0 gets its API key exactly the way a subprocess tool does. Details in the
[CLI reference](./reference/cli.md).

## The sandbox floor

Tools don't inherit the host's privileges. The sandbox denies network by default and
brokers credentials so secrets never enter the tool's environment; the docker backend
gets real per-host **allowlist egress** through a host-side sidecar egress proxy.
Today that floor lives in `@irisrun/sandbox` as a library — wiring it into the tool loop
so a tool automatically runs behind it is still in progress; see
[the sandbox](./guides/sandbox.md) for what's real now and what isn't.

## When a tool needs a secret

The bundled `now` tool needs nothing. The moment a subprocess tool needs a
`GITHUB_TOKEN` or an API key, two rules keep it safe: **declare names, not values** (the
image stores only the *names* of required secrets — never a value), and **supply values
at run time** (`--env-file` / `--env`, docker-compose style; a declared secret with no
value **refuses to run**, loudly). The full mechanics — the `*_FILE` delivery tier,
least-privilege env, and how this differs from the sandbox credential broker — are in the
**[secrets & environment guide](./guides/secrets.md)**.

## Approvals: tools that touch reality

Some tools are safe to retry (read-only); others are irreversible. Iris's default
harness includes an **approval gate** tactic: an irreversible tool call parks the
session for human approval before it runs, while read-only ("retry-safe") tools the
project bundles are allow-listed so they don't nag. That gate — and the journaled
audit trail it produces — is the subject of [Governance & approvals](./governance.md).

**Next → [Channels](./channels.md)**
