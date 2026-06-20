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

```json
{ "model": "openai/gpt-x" }
```

…or serve it explicitly with `iris serve --model openai`. See **[docs/06 — Models
& providers](../../docs/06-providers.md)** for the shared port and conformance suite.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
