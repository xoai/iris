# Deploy

The payoff of owning your state as a portable journal: the **same image resumes
the same session on a completely different host** — byte-identically, mid-task.
This chapter makes that turnkey on one real host, **Cloudflare Durable Objects**,
where a cold edge isolate per turn is the most vivid "resume somewhere else" proof
Iris has. Cloudflare is the demo; the portability is the point.

`iris deploy --target <name>` scaffolds for **nine targets** across three runtime
families (`iris deploy --list-targets`):

| Family | Targets | Shape |
|---|---|---|
| **edge** | `cloudflare` | Workers + Durable Objects; remote tools only |
| **container** | `render`, `gcp-cloud-run`, `azure-container-apps`, `digitalocean-app`, `docker` | a `Dockerfile` running `iris serve` + a per-platform manifest; durable store via `IRIS_STORE` (sqlite default) |
| **serverless** | `aws-lambda`, `gcp-cloud-functions`, `azure-functions` | a cold-per-turn handler with an **external** store via `DATABASE_URL` |

`--target` defaults to `cloudflare`. The capability gate runs per target, so an
agent that needs **local subprocess tools** is accepted on a container target (a
full `iris serve` process) but refused on the edge and serverless families (which
run remote tools only) — the gate routes you to the right host instead of shipping
something that breaks at runtime. The sections below use Cloudflare; the container
and serverless scaffolds follow the same gate → scaffold → (manual) deploy shape,
each printing its platform's deploy command.

## Scaffold an edge project

```sh
iris deploy ./image --out ./iris-edge
```

This reads the image, runs the capability gate, and writes a self-contained
Cloudflare Worker project into `./iris-edge`:

- `wrangler.toml` — the Worker + a Durable Object binding (`AGENT`, class `AgentDO`). `@irisrun/core`
  and `@irisrun/store-do` are edge-native (no `node:` built-ins), so no compatibility
  flags are needed.
- `worker.mjs` — the Worker. The agent's durable state lives in the Durable Object
  (single-writer lease + transactional storage + alarms = `sleepUntil`). The DO
  runs the **same `@irisrun/core`** unchanged on the edge.

The generated worker selects the model provider from your image's model-id prefix
and reads that provider's key from a secret (e.g. `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`); with no key it falls back to an inline echo so the deploy is
demoable. See [Models & providers](./providers.md).

## The capability gate

`iris deploy` refuses an over-capable image **before writing anything**. An image
that demands local subprocess tools cannot run on an edge isolate that supports
remote tools only — so the gate fails loudly with an explicit message rather than
shipping something that would break at runtime. Make the image edge-deployable by
using remote (MCP/gRPC) tools, or no tools.

## Actually deploying

The scaffold is the default; the real network egress is **opt-in and env-gated**
(it needs a Cloudflare account and `wrangler` on your PATH):

```sh
cd ./iris-edge
wrangler secret put ANTHROPIC_API_KEY    # the model key (or OPENAI_API_KEY) — for a real model
wrangler deploy
# or, driven by the CLI (set the secret first):
IRIS_DEPLOY=1 iris deploy ./image --out ./iris-edge --deploy
```

Without `IRIS_DEPLOY=1`, `--deploy` refuses to run `wrangler` — the install-free,
zero-runtime-dependency posture holds by default.

**The provider key is a Worker secret, not part of the image.** The Worker reads
`env.ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`); `wrangler secret put` stores it
**encrypted at rest** and injects it at runtime — it never enters the content-addressed
image, your repo, or `wrangler.toml`. With no secret set, the Worker falls back to an
inline echo, so a keyless deploy still runs (you just won't get a real model). The
per-host secret model is in [secrets & environment](./guides/secrets.md#secrets-in-production).

## The headline — resume on a *different* host

Because a session is just a journal, the **same image** can start a session on one
host, park at a turn boundary, and resume on another — from the same journal, with
byte-identical output. That cross-host resume is regression-locked in the test
suite, and the install-free proof runs locally:

```sh
node --conditions=iris-src examples/portability-demo.ts   # prints the proof, exits 0 on PASS
```

This is the north star: an agent a person talks to, that survives a host migration
mid-conversation.

**Next → [The harness](./harness.md)**
