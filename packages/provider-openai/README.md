# @irisrun/provider-openai

**A vendor-neutral, replay-safe model adapter.** The OpenAI `model_call` performer
sits behind Iris's portable model port — a peer of `@irisrun/provider-anthropic`
behind the *same* port — so swapping providers leaves the agent and its
**byte-identical journal replay** unchanged. No provider is baked into the core.
(Faithful record-replay of the captured reply, not a claim that the model is
deterministic.)

## What it is

A direct adapter for the **OpenAI Chat Completions** API over the built-in `fetch`
— zero runtime dependencies. It exposes a buffered performer
(`openaiModelPerformer`) and a streaming one (`openaiStreamingModelPerformer`)
that hold the same `content === join(deltas)` reconcile invariant as the Anthropic
adapter and pass the *same* shared conformance suite. The real adapter calls
OpenAI only when `OPENAI_API_KEY` is set; tests use a fake `fetch` / fake model.

## Use it

Selected automatically from an `openai/…` model prefix in your Agentfile:

```yaml
# agent.yaml
model: openai/gpt-x
```

…or serve it explicitly with `iris serve --model openai`.

This adapter speaks the **OpenAI Chat Completions protocol**, so `--base-url` (or
`IRIS_MODEL_BASE_URL`) on `iris run` / `serve` / `chat` points it at any compatible
endpoint — Groq, Together, Fireworks, OpenRouter, DeepSeek, Mistral, xAI, vLLM,
Ollama, LM Studio, Azure OpenAI. Which are **replay-safe vs known-divergent** is a
conformance-tested matrix in
**[`@irisrun/provider-compat`](../provider-compat/README.md)** (`iris providers --matrix`).

See **[docs/Models & providers](../../docs/providers.md)** for the shared port,
the conformance suite, and the compatibility matrix.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
