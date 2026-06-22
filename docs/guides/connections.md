# Connecting external services — tools, credentials, approvals

An Iris agent reaches the outside world through **tools**, and a tool is a
versioned contract invoked across a transport boundary — never inline code (see
[Tools](../tools.md)). So "connect an external service" is really three decisions:
which **transport** reaches it, how a **credential** gets there without leaking,
and which calls need a human **approval**. This page puts those three in one place.

## The transports — how a tool reaches a service

An Agentfile tool ref names its transport by scheme; the recognized set is exactly
`subprocess://`, `mcp://`, and `grpc://` (plus in-process for trusted, bundled
helpers). For *external* services, three matter:

| Transport | Reaches | Use it for |
|---|---|---|
| `subprocess://` | a local child process | a CLI or script on the host |
| `mcp://` | a Model Context Protocol server | reusable, language-agnostic tools (the common case) |
| `grpc://` | a remote gRPC service | a networked capability you already run |

The ref is part of the image's declared capabilities, and the deploy gate honors
it — a host that supports only remote tools **refuses** an image that demands local
subprocess tools, loudly, rather than degrade it silently (see [Deploy](../deploy.md)).

## Wiring an external MCP server (the common case)

An `mcp://` tool resolves at build time, but its server runs at run time. You map
each one to a command in an `mcp.json` beside the image — a JSON array of
`{ name, command, args? }`:

```json
[{ "name": "registry/mem0", "command": "npx", "args": ["-y", "mem0-mcp"] }]
```

The `name` is the tool's **location handle** — the `mcp://` ref minus its scheme,
shown by `iris inspect`. `command`/`args` spawn the server's stdio process. Point
the runtime at the file (it defaults to `mcp.json` beside the layout):

```sh
iris serve ./image --mcp mcp.json
```

`--mcp` works the same on `run`, `serve`, and `chat`. The image's **scoped tool
env** reaches each server — so an MCP memory like mem0 gets its API key exactly the
way a subprocess tool does (next section). For a worked example — a coding team
whose PM pins an `mcp://memory/mem0` tool reachable from Telegram — see the
[coding-team guide](./coding-team.md).

## Credentials — two layers, picked by where the tool runs

A connected tool almost always needs a secret. Iris keeps the **value** out of the
image, the journal, and any error message; *how* it's delivered depends on where
the tool runs.

- **Host-side tools** (`subprocess://`, `mcp://`, `grpc://`) — **declare the name**
  in the Agentfile and **supply the value at run time**:

  ```sh
  iris serve ./image --mcp mcp.json --env-file .env
  ```

  The Agentfile lists `secrets:` (names only); values come from `--env-file` /
  `--env` / `--secret-files`. A declared secret with no value **refuses to run**,
  loudly. Tools get only the declared env plus a fixed non-secret base — never your
  whole shell. Full mechanics in [secrets & environment](./secrets.md).

- **Untrusted code in a sandbox** — a different layer: the credential is brokered at
  the *network egress* boundary so the code never holds it (see
  [the sandbox](./sandbox.md) and its
  [threat model](../reference/security-sandbox-threat-model.md)). Note the sandbox
  is a library floor that isn't wired into the tool loop yet, so today the
  host-side path above is what a connected tool uses.

## Approvals — the calls that touch reality

Some connected tools are safe to retry (read-only); others are irreversible. The
default harness includes an **`approveIrreversible`** tactic: an irreversible call
parks the session for human approval *before* it runs, while retry-safe tools the
project bundles are allow-listed so routine reads don't nag. Every approval is
itself a journaled effect.

Layer identity on top with the `@irisrun/auth` policy — a declarative "who may
approve what" — by pointing the runtime at a policy file:

```sh
iris serve ./image --mcp mcp.json --policy policy.json
```

An unauthorized approval is converted to a skip, not honored, and the whole trail
is replayable from the journal. The gate, the `Principal`/role model, and in-chat
approvals are the subject of [Governance & approvals](../governance.md).

## Not yet / out of scope

Honest bounds, so omission doesn't read as a feature:

- **No OpenAPI / generic-HTTP transport.** The transport set is exactly
  in-process · `subprocess` · `mcp` · `grpc`. There is no "point at a
  `/openapi.json` and get tools" path and no generic HTTP-with-headers transport —
  `grpc://` is the remote option, and it needs a real gRPC service you run.
- **No interactive OAuth.** There is no "sign in to GitHub/Linear" flow, no token
  refresh, no `getToken()` dynamic provider, and no mid-call revocation handling.
  `@irisrun/auth` reasons over a **supplied** `Principal` (`{ id, roles }`); it does
  not mint or verify tokens (`packages/auth/src/identity.ts`). External-tool auth is
  **static** — declared secret names, values supplied at run time.
- **No per-tool visibility filtering.** There is no allow/block list that hides
  tools from the model; every tool in the image is perceivable. What exists is the
  approval gate (irreversible parks; retry-safe allow-listed) plus the
  who-may-approve policy — an *authorization* decision, not a visibility filter.

---

Built on the **[Tools](../tools.md)** boundary · credentials in
**[secrets & environment](./secrets.md)** · the gate in
**[Governance & approvals](../governance.md)** · every flag in the
**[CLI reference](../reference/cli.md)**.
