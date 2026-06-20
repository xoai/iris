# Agentfile reference

The Agentfile is the declarative manifest at the root of an agent project —
`agent.yaml` (the default) or `agent.json`. Both forms carry **identical fields** and
compile to the **same deterministic `imageDigest`**. It carries no executable behavior:
tools and connections are *referenced* by address, never embedded.

The whole contract ships as a **JSON Schema (draft 2020-12)** — run **`iris schema`**
for the authoritative, machine-readable version (editor autocomplete + CI validation).
This page is the human-readable companion.

## Every field

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
| `harness.bundle` | no | bundle ref | The tactic bundle — `"default"`, or a domain bundle (e.g. the coding bundle). See [the harness](../harness.md). |
| `harness.tactics` | no | `{ seam: ref }` | Per-seam tactic overrides (seams: `assembleContext`, `decideNext`, `onToolError`, `shouldCompact`, `gateAction`). |
| `requires.tool_locality` | no | `in-process` \| `local` \| `remote` | Where tools may run; checked against the host at deploy. |
| `requires.long_running` | no | bool | Needs a host that holds a live process. |
| `requires.local_subprocess` | no | bool | Must be `true` for any `subprocess://` tool. |
| `requires.filesystem` | no | bool | Needs host filesystem access. |
| `requires.websockets` | no | bool | Needs WebSocket channels. |
| `sandbox.backend` | yes | `inmemory` \| `docker` | Sandbox backend for tool execution. |
| `sandbox.network` | yes | e.g. `deny-all` | Network policy floor. |
| `sandbox.workspace` | no | path | A workspace directory, embedded by hash. |

## Validation

`iris build` validates loudly and refuses on:

- an unknown `apiVersion` / `kind`;
- an **inline-behavior** field (`code` / `script` / `source`) on a tool or connection —
  behavior is referenced by digest, never embedded;
- an unrecognized ref scheme. `subprocess://` additionally requires
  `local_subprocess: true` and rules out `tool_locality: "remote"`.

## The same manifest as JSON

`agent.json` is accepted verbatim — same fields, same `imageDigest` as the YAML form:

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

---

Back to **[Your first agent](../first-agent.md)** · **[Tools](../tools.md)** ·
the **[project README](../../README.md)**.
