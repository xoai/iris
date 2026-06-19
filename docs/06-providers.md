# 06 — Models & providers

"Bring your own model" is only real if more than one provider works. Iris ships two
behind a single tested port: **Anthropic** and **OpenAI**.

## The model-id prefix selects the provider

An agent's model is a single string in `agent.json` with a `<provider>/` prefix:

```json
{ "model": "anthropic/claude-x" }
```

```json
{ "model": "openai/gpt-x" }
```

- `anthropic/…` → `@iris/provider-anthropic`, key `ANTHROPIC_API_KEY`.
- `openai/…` → `@iris/provider-openai`, key `OPENAI_API_KEY`.
- a bare id with no prefix → Anthropic (backward-compatible default).
- any other prefix → a **loud** error listing the supported providers (never a
  silent call to the wrong API).

The prefix is stripped before the bare id is sent to the provider's API. The same
selection drives `iris run`, `iris chat`, `iris serve`, and the generated deploy
worker — set the prefix once in the Agentfile and every path follows it.

## Using OpenAI

Point the Agentfile at an `openai/…` model, set the key, and chat:

```sh
export OPENAI_API_KEY=sk-...
iris chat ./image --session o1 --db /tmp/o1.sqlite
```

Or serve it explicitly:

```sh
iris serve ./image --model openai --port 8787
```

`iris serve --model` accepts `auto | anthropic | openai | echo`. `auto` (the
default) uses the provider your image is pinned to **if** its key is set, otherwise
the no-key echo model so the server is always demoable.

## One port, one conformance suite

Both providers implement the same **model port**: a `model_call` performer
(`request → result`) where the request is `{ model, system?, messages[], maxTokens? }`
and the result is `{ role, content, stopReason, usage? }`. Tool-calling is **not**
part of this port — the harness drives tools itself — so a provider adapter is a
plain text-in / text-out adapter.

The proof that the two are interchangeable is a single, shared conformance suite
that **both** providers run with their own fixture: request shaping, model-id
resolution, loud failure on a missing model, non-2xx handling, the streaming
reconcile invariant (`content === join(deltas)`), the non-SSE fallback, and an
identical result shape. "Two providers pass the same tests behind the model port"
is a literal, executed guarantee, not a slogan.

## Adding your own provider

A provider is just a `model_call` performer — a function from the request JSON to an
outcome carrying a `{ role, content, stopReason, usage? }` result. Mirror
`@iris/provider-anthropic` / `@iris/provider-openai`:

1. Map the port request to your API's request (system prompt, messages, max tokens).
2. Parse the response back into the result shape.
3. Provide a buffered and a streaming variant; keep their model resolution and
   error handling **symmetric** (resolve `request.model ?? opts.model`, fail loudly
   when both are absent).
4. Run the shared conformance suite against it with a fixture.

That's the whole contract. Anything that satisfies it is a first-class Iris model.

**Next → [07 — Governance & audit](./07-governance.md)**
