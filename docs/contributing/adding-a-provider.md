# Adding a provider

A **provider** is how you put a new model backend behind Iris's vendor-neutral
model port — without baking a vendor into the agent, and without giving up
deterministic replay. [Models & providers](../providers.md) already shows the
shape from the outside; its [*Adding your own provider*](../providers.md#adding-your-own-provider)
section is the four-line summary. This page is the long form: the worked example,
the load-bearing step (canonicalization), and the suite that defines "done".

The whole contract is small. A provider is **a `model_call` performer** — a
function from the request JSON to an `Outcome` carrying a stable result — plus a
streaming twin. Tool-calling is *not* part of this port; the harness drives tools
itself, so an adapter is plain text-in / text-out. The two shipped providers,
`@irisrun/provider-anthropic` and `@irisrun/provider-openai`, are the references;
they pass one shared conformance suite, and so must yours.

## Step 1 — Implement the `model_call` performer

A performer is `(request: Json) => Promise<Outcome>` (`Performer` from
`@irisrun/core`), where `Outcome` is `{ ok: true; value: Json }` or
`{ ok: false; error: { message; code? } }`. You expose it as a **factory** that
closes over config — the Anthropic export is `anthropicModelPerformer(opts)`, the
OpenAI peer is `openaiModelPerformer(opts)`. Construct, resolve config once, return
the performer:

```ts
export function anthropicModelPerformer(opts: AnthropicOptions = {}): Performer {
  const { apiKey, doFetch, version, url } = resolveConfig(opts, "anthropicModelPerformer");

  return async (request: Json): Promise<Outcome> => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) {
      return {
        ok: false,
        error: {
          message:
            "anthropicModelPerformer: no model id (request.model and opts.model both absent)",
        },
      };
    }
    // … shape the request, fetch, canonicalize the reply (Step 2) …
  };
}
```

Four rules both references follow, and the suite enforces:

- **Resolve config — and fail loudly — at construction, not mid-turn.** Both
  adapters share a `resolveConfig(opts, label)` that reads `opts.apiKey ??
  process.env.ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and **throws** when there's
  no key *and* no injected `fetchImpl`. A registered performer that threw at call
  time would be laundered to `{ ok: false }` by the engine, so a missing key must
  surface at wiring time — loud, never a mid-turn silent failure.
- **`fetch` is injectable, and the only host touch.** The adapter uses the built-in
  `fetch` (zero deps), but takes `opts.fetchImpl` so tests run with no network and
  no key. That injection seam is exactly what the conformance suite drives.
- **No model id → loud `{ ok: false }`, and the fetch never fires.** Resolve
  `req.model ?? opts.model`; if both are absent, return an error whose message
  contains `no model id` *before* calling `fetch`. (The harness's `model_call`
  request carries only `{ messages }`, so a standalone caller bakes the id into
  `opts.model`; the request's own `model` still wins.)
- **A non-2xx response is a recordable `{ ok: false }`, not a throw.** On `!res.ok`,
  return `{ ok: false, error: { message, code: String(res.status) } }` — the
  status rides in `code` so a `429` is journaled as a `429`.

Keep the **buffered and streaming variants symmetric**: same model resolution, same
loud guard, same error posture. The OpenAI adapter's header note records why this is
non-negotiable — a buffered variant once shipped *without* the `?? opts.model`
fallback and 400'd a standalone caller. The streaming export
(`anthropicStreamingModelPerformer` / `openaiStreamingModelPerformer`) additionally
takes an `onDelta?: (text) => void` — a **non-journaled** live-UX side-channel — and
sends `stream: true` with `accept: text/event-stream`.

## Step 2 — Canonicalize the reply into `ModelCallResult` (the load-bearing step)

This is the step the whole port turns on. The endpoint's wire reply is *its* shape;
the journal records *yours*. You must collapse the vendor response into the stable
`ModelCallResult` and nothing else:

```ts
export interface ModelCallResult {
  role: "assistant";
  content: string;   // text blocks joined
  stopReason: string; // e.g. "end_turn" | "max_tokens"
  usage?: { inputTokens: number; outputTokens: number };
}
```

A model reply is a recorded journal effect that must **replay byte-identically**, so
canonicalization is where "compatible" silently breaks — vendors diverge on content
block shapes, on `stop_reason` vs `finish_reason`, on `usage` field names, on IDs.
Your job is to make those differences vanish at the boundary. Compare the two
references doing exactly that:

```ts
// Anthropic: text blocks joined; stop_reason; input_tokens/output_tokens
const result: ModelCallResult = {
  role: "assistant",
  content: (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(""),
  stopReason: body.stop_reason ?? "end_turn",
  ...(body.usage
    ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } }
    : {}),
};
```

```ts
// OpenAI: choices[0].message.content; finish_reason; prompt_tokens/completion_tokens
const choice = body.choices?.[0];
const result: ModelCallResult = {
  role: "assistant",
  content: choice?.message?.content ?? "",
  stopReason: choice?.finish_reason ?? "stop",
  ...(body.usage
    ? { usage: { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 } }
    : {}),
};
```

Two divergences to absorb on the *request* side too, because the port request is one
shape (`{ model, system?, messages[], maxTokens? }`) and your API may not match:

- **`system`.** Anthropic sends a top-level `system` field; OpenAI has none, so its
  adapter's `buildMessages` prepends a leading `{ role: "system", content }` message.
  Map the port's optional `system` to whichever your API wants.
- **`maxTokens`.** Both references send `req.maxTokens ?? 1024` as the API's
  `max_tokens`. Pick your API's field; keep the default explicit.

The streaming variant must canonicalize to the **same** `ModelCallResult` as the
buffered path — that's the reconcile invariant: `content === join(deltas)`. The
references factor the SSE read into `readAnthropicSse` / `readOpenAiSse`, which join
text deltas, track the stop reason, and accumulate usage, returning an accumulator
that the performer folds into the identical result. A malformed `data:` frame is
**skipped, never thrown** (one bad frame can't crash a turn), and a multibyte rune
split across chunks is held by a streaming `TextDecoder` (never emitted as U+FFFD).

If a vendor concept has no clean home in `ModelCallResult` — omit it. The port is
exactly four fields; do not widen it. Anything you can't canonicalize, you can't
replay.

## Step 3 — Get selected by the `<provider>/` prefix

Once the adapter exists, wire it into selection. An agent's model is a single
`<provider>/` -prefixed string in the Agentfile; `iris run / serve / chat` and the
deploy worker all resolve the provider from that prefix via
`packages/cli/src/providers.ts`. Selection is a static descriptor plus a lazy import:

```ts
const DESCRIPTORS: Record<ProviderName, ProviderDescriptor> = {
  anthropic: {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    pkg: "@irisrun/provider-anthropic",
    bufferedExport: "anthropicModelPerformer",
    streamingExport: "anthropicStreamingModelPerformer",
  },
  openai: { /* OPENAI_API_KEY, @irisrun/provider-openai, openai{,Streaming}ModelPerformer */ },
};
```

`providerNameForModel(modelId)` maps the prefix to a provider: a **bare id** (no
slash) → `anthropic` (the backward-compatible default), a **known** prefix → that
provider, and **any other** prefix throws loudly listing the supported set — never a
silent POST to the wrong API. `stripModelPrefix` removes the segment before the bare
id reaches your API; `loadModelProvider` dynamic-imports your package and checks the
two named exports are present. So a new provider is: add a `ProviderDescriptor` entry
pointing at your package and its two factory export names, and widen `ProviderName`.

You don't change the prefix mechanism — you register against it. If you only want to
reach a *compatible* endpoint over a protocol Iris already speaks, you don't write a
provider at all: point `--base-url` (deployment knob; also `IRIS_MODEL_BASE_URL`) at
it and reuse the matching adapter — see [Models & providers](../providers.md#point-base_url-at-any-compatible-endpoint).
`opts.baseUrl` is exactly the seam the adapter reads (`opts.baseUrl ?? DEFAULT_URL`).

## Step 4 — Pass the shared conformance suite (the definition of "done")

"Two providers pass the same tests behind the model port" is the literal guarantee,
and it's what makes your provider first-class. The suite lives at
`tests/lib/model-provider-conformance.ts`; you supply a **`ConformanceFixture`** and
call `runModelProviderConformance(fixture)`. The fixture is only the
provider-specific surface — your two factories, your representative wire bodies, and
the request-shape assertions:

```ts
const fixture: ConformanceFixture = {
  name: "anthropic",
  envKey: "ANTHROPIC_API_KEY",
  makeBuffered: (opts) => anthropicModelPerformer(opts),
  makeStreaming: (opts) => anthropicStreamingModelPerformer(opts),
  bufferedResponseBody: () => ({ /* your HTTP-200 body: "Hi there", in:5 out:2 */ }),
  streamingSseBody: () => sse(/* your SSE frames: "Hi", " there", stop, usage */),
  fallbackResponseBody: () => ({ /* a non-SSE body for the fallback test */ }),
  malformedSseBody: () => `event: e\ndata: {not valid json\n\n` + sse(/* one good delta + stop */),
  expected: { content: "Hi there", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  expectedFallback: { content: "Hello", usage: { inputTokens: 3, outputTokens: 4 } },
  assertRequestShape: (cap, sentApiKey) => { /* assert your URL, auth header, body fields */ },
  modelFromBody: (body) => body.model,
};

runModelProviderConformance(fixture);
```

The suite drives your fixture through one behavioral checklist — pass it and you are
done:

- **Buffered** shapes the request correctly (`assertRequestShape`) and canonicalizes
  the response to `expected`.
- **Model resolution:** `opts.model` fills in when the request carries none; with
  *neither* request nor opts model → `{ ok: false }` matching `/no model id/`, and
  `fetch` is **never called**.
- **Failure posture:** a non-2xx returns `{ ok: false }` with `error.code` equal to
  the status (`"429"`); constructing with no key **and** no `fetchImpl` throws,
  matching your `envKey`.
- **Streaming:** parses SSE, fires `onDelta` in order, and holds the reconcile
  invariant `content === join(deltas)`; a non-SSE content-type falls back to a
  buffered read emitting exactly one delta; a malformed first frame is skipped, not
  thrown; a missing model id is loud before any fetch.
- **Result shape is exactly** `{ role, content, stopReason, usage? }`, `role` is
  `"assistant"`, and `usage` has exactly `{ inputTokens, outputTokens }`.

> Note (registration, not invention): the suite is **synchronous** — `runModel
> ProviderConformance` calls `node:test`'s `test()` in its body, and your `*.test.ts`
> calls it at module load. Do not wrap it in an async IIFE or a deferred callback, or
> the tests won't register.

Optionally, once your adapter canonicalizes a representative endpoint reply, add a
row to `@irisrun/provider-compat`'s matrix
(`packages/provider-compat/src/matrix.ts`) so the endpoint is classified
**replay-safe** vs **known-divergent** and pinned by CI. `iris providers --matrix`
prints it. See [Models & providers](../providers.md#point-base_url-at-any-compatible-endpoint)
for what those two classes mean.

## Checklist

- [ ] The adapter is a factory returning a `Performer` —
      `(request: Json) => Promise<Outcome>` — with a streaming twin that takes
      `onDelta`.
- [ ] Config resolves once at construction; a missing key with no injected
      `fetchImpl` **throws** (loud, not mid-turn).
- [ ] `fetch` is injectable (`opts.fetchImpl`); the adapter has no other host import.
- [ ] No model id (`req.model ?? opts.model` both absent) → `{ ok: false }` with
      `no model id`, **before** any fetch. Buffered and streaming are symmetric.
- [ ] A non-2xx → `{ ok: false, error: { code: String(status) } }`, not a throw.
- [ ] The reply is **canonicalized** to `ModelCallResult` —
      `{ role: "assistant", content, stopReason, usage? }`, exactly four fields, no
      vendor leakage. Streaming canonicalizes to the *same* result
      (`content === join(deltas)`); malformed frames skipped, runes held.
- [ ] A `ProviderDescriptor` registers the package + its two export names; the
      `<provider>/` prefix selects it, `--base-url` / `opts.baseUrl` redirects where
      it POSTs.
- [ ] A `ConformanceFixture` runs `runModelProviderConformance` and the suite is
      green (registered synchronously at module load).

## See also

- [Models & providers](../providers.md) — the model port from the outside: the
  `<provider>/` prefix, the OpenAI/Anthropic protocols, the conformance-tested
  compatibility matrix, and the [*Adding your own provider*](../providers.md#adding-your-own-provider)
  summary this page expands.
- [Architecture](../architecture.md) — where the `model_call` effect sits in the
  record-replay engine, and why a canonicalized reply is what makes a session replay
  byte-identically regardless of which adapter produced it.
