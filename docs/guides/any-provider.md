# Run on any provider — one image, any endpoint

Build an agent once and point it at whatever model serves you best: Anthropic or
OpenAI direct, a fast gateway like Groq or Together, or a model running on your
own laptop. The **endpoint is a deploy-time knob**, not something baked into the
image — so the same content-addressed agent runs anywhere, and its digest never
changes.

> Builds on [Models & providers](../providers.md) — read it for the provider port
> and the two protocols. This guide is the practical "swap the endpoint without
> rebuilding" recipe.

## The one idea: the model id picks a protocol, base_url picks the endpoint

Two independent choices:

- The **model id prefix** selects the *protocol*. `anthropic/...` speaks the
  Anthropic Messages API; `openai/...` speaks OpenAI Chat Completions. (A bare id
  defaults to Anthropic.) This is part of the Agentfile, so it's in the image.
- The **base URL** selects the *endpoint* for that protocol — and it is **not** in
  the image. Set `--base-url <url>` (or `IRIS_MODEL_BASE_URL`) on `run` / `serve` /
  `chat`, and a portable image is redirected to any compatible endpoint at deploy
  time. The image digest stays endpoint-neutral, so the artifact you audited is
  the artifact you run.

```sh
# the same image, three places — no rebuild, identical digest
iris chat ./image --session s --db a.sqlite                          # Anthropic/OpenAI direct (by the model prefix)
OPENAI_API_KEY=... iris serve ./image --base-url https://api.groq.com/openai/v1   # a Groq gateway
iris run ./image --session s --db a.sqlite --base-url http://localhost:11434/v1   # a local model
```

## Know which endpoints are replay-safe

Iris ships a tested compatibility registry — OpenAI-protocol gateways (Groq,
Together, Fireworks, OpenRouter, DeepSeek, Mistral, xAI), Anthropic-protocol
clouds (Bedrock, Vertex), and local servers (Ollama, LM Studio, vLLM). Each is
classified **replay-safe** or **known-divergent**, and a CI conformance test pins
the classification so it can't rot:

```sh
iris providers            # the protocols Iris speaks
iris providers --matrix   # the endpoint compatibility matrix, with the classification
```

Why the classification matters: Iris's durability rests on **byte-identical
replay** of recorded model calls. A **replay-safe** endpoint round-trips the
request/response shape faithfully, so a recorded session replays exactly. A
**known-divergent** endpoint differs in ways that can break that byte-identity —
still fine to *run*, but check the matrix before you rely on it for
replay-verified audit or cross-host migration. The matrix is how you choose with
eyes open rather than discovering it later.

## Use a local model

The local servers are just OpenAI-protocol endpoints, so point `--base-url` at
them — useful for offline development, cost-free iteration, or keeping data on the
box:

```sh
# Ollama (default :11434) or LM Studio (default :1234) — both OpenAI-compatible
iris chat ./image --session dev --db dev.sqlite --base-url http://localhost:11434/v1
```

Develop against a local model, then flip to a hosted one for production by
changing a single flag — the agent, its tools, and its journal don't know the
difference.

## Why one image is enough

Because the endpoint lives outside the image, you get the portability that the
rest of Iris promises: build and audit a single artifact, then run it on the
cheapest replay-safe endpoint today and a different one tomorrow without a
rebuild, a new digest, or a touched Agentfile. The provider port is one tested
seam ([Models & providers](../providers.md)) — every endpoint behind it is the
same code to the agent.

## Going deeper

- [Models & providers](../providers.md) — the port, the two protocols, and adding
  your own provider.
- [Never-lose-state agent](./portable-durable-agent.md) — why replay-safety feeds
  the durability guarantee.

---

Related: [Models & providers](../providers.md) · [Secrets & environment](./secrets.md) · [Deploy](../deploy.md).
