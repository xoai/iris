# Observability

Your agent already records everything it does — every model call, tool call,
approval, and marker lands in the journal as an ordered effect. `@irisrun/observe`
turns that record into **OTel-shaped spans** you can ship to a tracing backend. The
key move: spans are *derived from the journal after the fact*, never fed back in. So
you can trace a turn and it still replays byte-for-byte the same.

> This is the read-only sibling of [`iris audit`](../audit-and-evals.md). Audit reads
> the journal for a compliance trail; observe reads the same journal for a span tree.
> Neither one touches replayed state.

## The one idea: spans are a projection of the journal

`toSpans` takes a recorded session's inspection and returns a flat array of `Span`s —
a root `turn` span with one child per effect and one per marker. It reads nothing but
the records. It mutates nothing. The recording run was captured under
`assertReplay: true`, and spans are computed *afterward*, so adding observability
cannot change what the agent did or how it replays.

```ts
import { inspectSession } from "@irisrun/inspect";
import { toSpans } from "@irisrun/observe";

const insp = await inspectSession(store, "s1");
const spans = toSpans(insp); // pure + deterministic over the journal bytes
```

Because `toSpans` is a pure function of the journal, re-inspecting and re-spanning the
same store is byte-identical — the same property that makes the journal verifiable in
the first place.

## The span tree

`toSpans` walks the records once and produces three kinds of span:

| Span | `name` | Source record | Parent |
|---|---|---|---|
| root | `turn` | the whole session | (none) |
| effect | `effect:<effectKind>` | an `effect_intent`, joined to its `effect_result` | the root `turn` |
| marker | `marker:<marker>` | a `marker` record (e.g. `marker:finish`, `marker:wait`) | the root `turn` |

Every `Span` carries `spanId`, optional `parentSpanId`, `startTimeUnixNano`,
`endTimeUnixNano`, an `attributes` bag, and a `statusCode` of `"OK"`, `"ERROR"`, or
`"UNSET"`.

The root's status reflects the terminal state: a `finished` turn is `OK`, anything
else is `UNSET`. An effect span is `OK` or `ERROR` based on its result outcome, or
`UNSET` if the intent has no matching result yet (a turn parked mid-effect). So a
parked turn spans up to the park — you get a `marker:wait`, no `marker:finish`, and an
`UNSET` root — which is exactly what the inspection records.

## Deterministic spanIds — no RNG

A `spanId` is built from identity, not randomness:

- the root is `<sessionId>#turn`
- every effect and marker span is `<sessionId>#<seq>` — the record's sequence number

That's the whole rule. No clock, no random bytes. Re-spanning the same session yields
the same ids every time, which is what lets you diff two span exports or correlate a
span back to record `#<seq>` in `iris audit`. The effect span also folds its result
back in: it carries `effectId`, `effectKind`, and `seq` in `attributes`, and its end
time is the result's timestamp.

## Timing comes from the record

Span start/end are the journal records' own `ts` values — the intent's timestamp for
the start, the result's for the end (or the intent's again if there's no result yet).
The root's `startTimeUnixNano` is the first record's `ts` and its end is the last.

This is the one place observability is *allowed* to read `ts`. The determinism
contract forbids reducers and the step function from reading timestamps — those must
be pure folds over the records. Observe runs *outside* that path, on an already-sealed
journal, so reading `ts` for span timing is safe and changes nothing about replay.

## The injected Sink

`toSpans` only builds spans. Where they go is a separate, swappable concern — the
`Sink`:

```ts
export interface Sink {
  export(spans: Span[]): void | Promise<void>;
}
```

Two are built in:

| Sink | Use |
|---|---|
| `collectingSink()` | returns `{ sink, spans }`; accumulates exported spans in memory — for tests and assertions |
| `consoleSink()` | prints one JSON span per line — a stand-in for a real exporter |

Wiring is exactly what you'd expect: build the spans, hand them to a sink.

```ts
import { toSpans, consoleSink } from "@irisrun/observe";

const spans = toSpans(await inspectSession(store, "s1"));
await consoleSink().export(spans);
```

Or collect them to assert on:

```ts
import { collectingSink } from "@irisrun/observe";

const { sink, spans: collected } = collectingSink();
await sink.export(toSpans(insp));
// collected now holds every span, in order
```

To send spans somewhere `consoleSink` and `collectingSink` don't reach, implement the
one-method `Sink` interface yourself and call your backend inside `export`.

## Real OTLP export

The package is install-free: it has no OpenTelemetry dependency, so building spans
needs nothing beyond `@irisrun/core` and `@irisrun/inspect`. Pushing those spans to a
*real* OTLP backend needs the `@opentelemetry/*` SDK, which is a future deliverable.

That seam is covered by a manual smoke at `tests/smoke/otlp-export-smoke.ts`. It is
not in the unit suite and not typechecked. It runs only when you opt in:

```sh
IRIS_OTLP_SMOKE=1 node tests/smoke/otlp-export-smoke.ts
```

When enabled, it records a finished session, builds the spans install-free, then
attempts to `import("@opentelemetry/sdk-trace-base")`. If the SDK is absent it
**refuses loudly** with install guidance and exits non-zero — it never fakes a real
export. With `IRIS_OTLP_SMOKE` unset, it prints a skip line and does nothing. The
honest boundary: the spans are real today; the OTLP wire export is the future target.

## Going deeper

- The spans are a projection of the same record that powers
  [audit & reproducible evals](../audit-and-evals.md) — `iris audit` reads it for a
  compliance trail, observe reads it for a span tree.
- That record travels: see [verifiable portable journals](../verifiable-journal.md)
  for how a session becomes a single self-contained, verifiable file.
