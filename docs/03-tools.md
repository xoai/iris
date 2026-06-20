# 03 — Tools

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
[05 — Deploy](./05-deploy.md)).

## The sandbox floor

Tools don't inherit the host's privileges. The sandbox denies network by default and
brokers credentials so secrets never enter the tool's environment; the docker backend
gets real per-host **allowlist egress** through a host-side sidecar egress proxy.

## Secrets & environment

A subprocess tool often needs a secret — a `GITHUB_TOKEN`, an API key. Two rules
keep that safe:

1. **Declare names, not values.** An Agentfile lists the env its tools need; the
   image stores only NAMES. A secret VALUE never enters the manifest, the image, or
   the journal.
2. **Supply values at run time**, docker-compose style:

```yaml
# agent.yaml
secrets:            # NAMES of required secrets — values supplied at run time
  - GITHUB_TOKEN
environment:        # non-secret literal defaults (baked into the recipe)
  LOG_LEVEL: info
```

```
# values come from a file and/or flags at run time (never committed):
iris run ./image --session s1 --env-file .env --env LOG_LEVEL=debug
```

`--env-file` (repeatable) reads `KEY=VALUE` lines; `--env KEY=VALUE` (repeatable)
overrides. Precedence for a declared secret: `--env` > `--env-file` > the host
environment. A declared secret with no value from any source **refuses to run** —
loudly, by name, never a half-started session. `iris inspect` shows exactly what an
image requires.

> ⚠ Passing a secret with inline `--env GITHUB_TOKEN=…` puts the **value on the
> command line** (visible in `ps`, shell history, `/proc/<pid>/cmdline`). Iris warns
> when you do this — use `--env-file` for secrets, and `--env` only for non-sensitive
> overrides.

**Two delivery tiers.** By default a secret is delivered as an **environment
variable** (the tool reads `process.env.GITHUB_TOKEN`). For the strongest isolation,
add `--secret-files`: each secret is written to a `0600` temp file and the tool
receives `GITHUB_TOKEN_FILE=/run/iris-secrets/GITHUB_TOKEN` instead — the **value
never enters the tool's environment** at all (the same `*_FILE` convention apps use
for `/run/secrets/*`). Your tool reads the path:

```
# inside a tool, prefer the file when present:
const token = process.env.GITHUB_TOKEN_FILE
  ? readFileSync(process.env.GITHUB_TOKEN_FILE, "utf8").trim()
  : process.env.GITHUB_TOKEN;
```

**Least privilege.** When an Agentfile declares `secrets`/`environment`, its
subprocess tools receive ONLY that declared env plus a fixed, non-secret base
(`PATH`, `HOME`, proxy/TLS vars) — never the operator's whole shell. An undeclared
`--env`/`--env-file` key is refused, so a stray secret can't leak in through a
copied env file.

This is a different layer from the [sandbox credential broker](./reference/security-sandbox-threat-model.md):
the broker injects a secret at the *network egress* boundary so a sandboxed tool
never sees it; subprocess-tool env is *host-side*, for a tool that legitimately
needs the value in its environment to run. Both keep the value out of the image and
the journal. An Agentfile that declares neither keeps today's behavior — the tool
inherits the host environment.

## Approvals: tools that touch reality

Some tools are safe to retry (read-only); others are irreversible. Iris's default
harness includes an **approval gate** tactic: an irreversible tool call parks the
session for human approval before it runs, while read-only ("retry-safe") tools the
project bundles are allow-listed so they don't nag. That gate — and the journaled
audit trail it produces — is the subject of [07 — Governance & audit](./07-governance.md).

**Next → [04 — Channels](./04-channels.md)**
