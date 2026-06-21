# A coding team — PM plans, Engineer codes, QC reviews

This is the full-stack recipe: a **coding team** of three agents, each on the model
that suits its job, sharing durable Postgres state, remembering across sessions
through an MCP memory, and reachable from **Telegram**. A **PM** (Opus 4.8) plans
and delegates; an **Engineer** (Kimi, on Moonshot's OpenAI-compatible endpoint)
writes the code; a **QC** reviewer (gpt-5.5) checks it. One image, one `serve`, one
bridge process.

> This is a recipe on top of three guides — read them first for the mechanics:
> [Subagents](./subagents.md) (delegation + **per-child models**), [Tools](../tools.md)
> (wiring an **MCP server**), and the [`@irisrun/bridge` README](../../packages/bridge/README.md)
> (reaching a chat platform). It's the heavier sibling of
> [Multi-agent teams](./multi-agent-team.md); start there for the team idea.

## The one idea, again: a teammate is a tool

There's no agent mesh here either. The **PM is the orchestrator** — a normal agent
whose tools happen to be other agents — and the Engineer and QC are child images it
delegates to. What's new versus the marketing-team recipe is that each teammate runs
a **different model at a different endpoint with a different key**, and the team is
wired for production: a real database, persistent memory, and a public channel.

| Role | Where it runs | Model | Endpoint / key |
|---|---|---|---|
| **PM** (orchestrator) | the served image | `anthropic/claude-opus-4-8` | default Anthropic (`ANTHROPIC_API_KEY`) |
| **Engineer** | child image | `openai/kimi-k2` | `baseUrl https://api.moonshot.ai/v1`, key `MOONSHOT_API_KEY` |
| **QC** | child image | `openai/gpt-5.5` | default OpenAI (`OPENAI_API_KEY`) |

The model ids above are **placeholders** — swap in the exact ids your accounts
expose. The Engineer rides the **OpenAI wire protocol** (`openai/` prefix) but
reaches Moonshot through `baseUrl`, so no new provider code is needed.

## Build the three images

Each teammate is an ordinary agent project — scaffold it, give it focused
instructions, and build it to an image directory.

```sh
# the Engineer
iris init engineer
# edit engineer/instructions.md — "You are a senior engineer. Implement the PM's
# spec as a single, reviewable change. Return the diff and a short rationale."
iris build --file engineer/agent.yaml --out ./coding-team/children/engineer

# the QC reviewer
iris init qc
# edit qc/instructions.md — "You review a change for correctness, tests, and risk.
# Return APPROVE or REQUEST-CHANGES with specific, line-level reasons."
iris build --file qc/agent.yaml --out ./coding-team/children/qc
```

The PM is the orchestrator — an agent whose **job is to delegate**. Its instructions
name the delegate tools and the order to use them:

```markdown
<!-- coding-team/instructions.md -->
You are the PM. Turn the request into shipped, reviewed code:

1. Write a short spec and plan for the request.
2. Call `implement` with the spec to have the Engineer produce the change.
3. Call `review` with the change to have QC check it.
4. If QC requests changes, loop back to `implement` with the feedback.

Return the approved change plus a one-line summary of what shipped.
```

Drop the `subagents.json` below beside `coding-team/agent.yaml`, then build the PM:

```sh
iris build --file coding-team/agent.yaml --out ./coding-team/image
```

## Wire the heterogeneous team — `subagents.json`

This is where each teammate gets its own model, endpoint, and key. The PM's two
delegate tools map to the child images, with the per-child overrides from
[Subagents → Per-child model, endpoint, and key](./subagents.md#per-child-model-endpoint-and-key):

```json
[
  { "name": "implement", "image": "./children/engineer",
    "model": "openai/kimi-k2", "baseUrl": "https://api.moonshot.ai/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
  { "name": "review", "image": "./children/qc", "model": "openai/gpt-5.5" }
]
```

- `implement` → the Engineer: `model` overrides the child image's model id, `baseUrl`
  points it at Moonshot, and `apiKeyEnv` reads `MOONSHOT_API_KEY` instead of the
  standard `OPENAI_API_KEY` — so an OpenAI-protocol child reaches a third-party
  endpoint with its own key.
- `review` → QC: just a `model` override; it uses the default OpenAI endpoint and
  `OPENAI_API_KEY`.
- The **PM itself** runs its image's pinned `anthropic/claude-opus-4-8` — no entry
  needed; the orchestrator selects its provider the usual way.

A child whose key env isn't set falls back to a deterministic echo model, so you can
run the whole wiring keyless before spending a token (see *Run it* below).

## Give it memory — `mcp.json`

Persistent memory is an **MCP tool** the image declares and the host wires at run
time. Say the PM image pins a memory tool `mcp://memory/mem0`; map its
**location handle** (the `mcp://` ref minus scheme, shown by `iris inspect`) to the
mem0 server in an `mcp.json` beside the image:

```json
[{ "name": "memory/mem0", "command": "npx", "args": ["-y", "<your-mem0-mcp-server>"] }]
```

The image's **scoped tool env** reaches the server, so the `MEM0_API_KEY` the
Agentfile declares — and you supply via `--env-file` — is delivered to mem0 exactly
the way a subprocess tool's secrets are. See [Tools → Wiring an MCP server](../tools.md)
for the handle-matching rule (a name that doesn't match a declared `mcp://` tool
fails loudly at `iris inspect`).

## Durable shared storage — Postgres

The team shares one durable store so a crash or restart never loses a session.
Install the `pg` driver (an **optional peer** of `@irisrun/store-postgres` — it isn't
pulled into Iris's own tree), point `--store` at the package, and pass your DSN as
`--db`:

```sh
npm install pg                       # the optional peer, in your deployment
export DATABASE_URL="postgres://user:pass@host:5432/iris"
```

> **Certify it first.** The store's SQL is exercised by an env-gated live-Postgres
> smoke that runs the same conformance suite the built-in stores pass — not by Iris's
> CI (which has no database). Run it once against your DSN before production, as
> described in [Adding a store](../contributing/adding-a-store.md). This is the same
> honesty bar as the docker/edge smokes: the operator certifies the host-specific
> piece.

## Run it

Put it all together. A `.env` carries the four keys and the DSN
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `MEM0_API_KEY`,
`DATABASE_URL`). Prove the wiring keyless first — every agent echoes deterministically
with no key, so you can watch a delegation flow before spending a token:

```sh
iris chat ./coding-team/image --subagents subagents.json --fake
```

Then bring up the real team behind HTTP:

```sh
iris serve ./coding-team/image \
  --store @irisrun/store-postgres --db "$DATABASE_URL" \
  --subagents subagents.json --mcp mcp.json \
  --env-file .env --port 8787
```

That one process is the whole team: the PM on Opus, delegating to the Kimi Engineer
and the gpt QC, remembering through mem0, persisting to Postgres, listening on
`:8787`.

## Put Telegram in front

Iris has no first-party Telegram channel — and doesn't need one. A **bridge** is a
small external process that maps a platform's webhook to the durable REST session,
with the wire protocol (session minting, the rotating continuation token) handled by
[`@irisrun/bridge`](../../packages/bridge/README.md). The Telegram adapter is a
worked example you copy:

```ts
// telegram-bridge.ts — run alongside `iris serve`
import { makeTelegramBridge } from "./telegram.ts"; // copy from tests/examples/bridges/telegram.ts

const bridge = makeTelegramBridge({
  baseUrl: "http://127.0.0.1:8787",         // the `iris serve` above
  secretToken: process.env.TELEGRAM_SECRET!, // the secret you set on the webhook
});

// in your HTTP handler for Telegram's webhook POST:
const { status, body } = await bridge.handle(req.headers, rawBody);
```

Register the webhook with Telegram's `setWebhook` using the same `secret_token`; the
adapter checks the `X-Telegram-Bot-Api-Secret-Token` header constant-time and
**verifies before any turn runs** (a bad secret is `401`, never a wasted delegation).
The `discord.ts` and `teams.ts` siblings in `tests/examples/bridges/` are the same
shape for other platforms.

## What a delegation does, and how it can end

Each `implement` / `review` call drives the child agent to a terminal state and maps
the outcome back to the PM as a normal tool observation — only genuine infra
contention is a retryable failure:

| Child outcome | The PM sees |
|---|---|
| `finished` | the child's `output` — the normal case (the diff, the review verdict) |
| `parked` | the child paused — e.g. QC waiting on a [human approval](./human-in-the-loop.md) before APPROVE |
| `exhausted` | the child hit its turn cap without converging — a real observation, not a fault |
| `aborted` | infra lease/seq loss — the only failure, and the only one retried |

A parked QC is a feature, not a bug: gate the final APPROVE behind a human and the
review pauses durably, the whole team survives a restart, and the sign-off resumes
the exact session. The PM, the Engineer, and the QC each run in their own derived
session id under the shared Postgres store, so the entire run is replayable and
[auditable](./auditable-agent.md) end to end.

## Honest caveats

- **Model ids are placeholders.** `claude-opus-4-8`, `kimi-k2`, `gpt-5.5` stand in
  for whatever ids your accounts actually expose — set them to real ones.
- **Postgres SQL is operator-certified.** Iris's CI has no database; run the store's
  live smoke against your DSN before production (above).
- **mem0 is an external server you supply.** The `mcp.json` shows the wiring; the
  command/args/key are whatever your chosen mem0 MCP needs.
- **A model error doesn't brick the session.** A provider failure surfaces as the
  agent's reply (`⚠️ model error: …`) and the turn parks normally — the journal stays
  sound and the next message retries.

## Going deeper

- [Subagents](./subagents.md) — the delegation mechanics and the per-child model fields.
- [Multi-agent teams](./multi-agent-team.md) — the lighter, single-provider version of this recipe.
- [Secrets & environment](./secrets.md) — how the four keys are declared and delivered.
- [Human-in-the-loop](./human-in-the-loop.md) — make QC's APPROVE wait for a person.
- [Auditable agent](./auditable-agent.md) — prove what the team did, turn by turn.
- [`@irisrun/bridge`](../../packages/bridge/README.md) — bridge any platform; certify the adapter.
- [Adding a store](../contributing/adding-a-store.md) — the `openStore` contract and the conformance smoke.
