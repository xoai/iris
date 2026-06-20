# @irisrun/observe

**OTel-shaped spans, derived from the journal — determinism intact.** Your agent
already recorded everything it did. This turns a recorded session's inspection
into spans, so observability is a *projection* of the journal, not a side effect
woven through the engine. A turn that was observed still replays byte-identically.

## What it is

`toSpans(inspection)` takes a `SessionInspection` (from `@irisrun/inspect`) and
returns OTel-shaped `Span[]`: a root `turn` span parenting one child per effect
(intent→result, carrying its outcome) and one per marker. `spanId`s are
DETERMINISTIC — `sessionId#seq`, no RNG — so re-spanning is byte-identical;
timing reads the journal's recorded `ts`.

Emission goes through an injected `Sink` (`export(spans)`), decoupling spans from
any backend: `collectingSink()` accumulates in memory (for tests),
`consoleSink()` prints one JSON span per line. Real OTLP export is a gated manual
smoke. Depends on `@irisrun/core` + `@irisrun/inspect` only.

## Use it

```ts
import { toSpans, collectingSink } from "@irisrun/observe";
import { inspectSession } from "@irisrun/inspect";

const { sink, spans } = collectingSink();
await sink.export(toSpans(await inspectSession(store, "s1")));
```

See **[docs/Observability](../../docs/guides/observability.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
