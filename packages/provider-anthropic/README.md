# @irisrun/provider-anthropic

**A vendor-neutral, replay-safe model adapter.** The Anthropic `model_call`
performer sits behind Iris's portable model port: the agent names a *model*, not a
vendor, and because each reply is captured as a journaled effect, a recorded
session replays **byte-identically from its journal** — no provider is baked into
the core, and swapping one out never changes a past session's replay. (That's
faithful record-replay of the captured reply, not a claim that the model itself is
deterministic.)

## What it is

A direct adapter for the **Anthropic Messages** API over the built-in `fetch` —
zero runtime dependencies. It exposes a buffered performer
(`anthropicModelPerformer`) and a streaming one
(`anthropicStreamingModelPerformer`) that emit token deltas while holding the
`content === join(deltas)` reconcile invariant. The real adapter calls Anthropic
only when `ANTHROPIC_API_KEY` is set; the test suite runs it against a fake
`fetch` / fake model, so nothing in the suite touches the network.

## Use it

Selected automatically from an `anthropic/…` model prefix in your Agentfile — set
the prefix once and `iris run` / `chat` / `serve` / `deploy` all follow it:

```json
{ "model": "anthropic/claude-x" }
```

This adapter speaks the **Anthropic Messages protocol**, not just Anthropic itself:
point it at any compatible endpoint with `--base-url` (or `IRIS_MODEL_BASE_URL`) on
`iris run` / `serve` / `chat` — Bedrock and Vertex Claude among them. Which endpoints
are **replay-safe vs known-divergent** is a conformance-tested matrix in
**[`@irisrun/provider-compat`](../provider-compat/README.md)** (`iris providers --matrix`).

See **[docs/06 — Models & providers](../../docs/06-providers.md)** for the model
port, the shared conformance suite, the compatibility matrix, and how to add a third
provider.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
