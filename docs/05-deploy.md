# 05 — Deploy

Portability is only a selling point once *one* host is turnkey. That host is
**Cloudflare Durable Objects** — a cold edge isolate per turn is the most vivid
"resume somewhere else" demo Iris has.

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
demoable. See [06 — Models & providers](./06-providers.md).

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
cd ./iris-edge && wrangler deploy        # the printed next step
# or, driven by the CLI:
IRIS_DEPLOY=1 iris deploy ./image --out ./iris-edge --deploy
```

Without `IRIS_DEPLOY=1`, `--deploy` refuses to run `wrangler` — the install-free,
zero-runtime-dependency posture holds by default.

## The headline — resume on a *different* host

Because a session is just a journal, the **same image** can start a session on one
host, park at a turn boundary, and resume on another — from the same journal, with
byte-identical output. That cross-host resume is regression-locked in the test
suite, and the install-free proof runs locally:

```sh
node manual/portability-demo.ts        # prints the proof, exits 0 on PASS
```

This is the north star: an agent a person talks to, that survives a host migration
mid-conversation.

**Next → [06 — Models & providers](./06-providers.md)**
