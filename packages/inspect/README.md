# @irisrun/inspect

**See what your agent decided — read-only, snapshot-safe.** A recorded session
is a snapshot plus a journal; this reads it back as a decision/effect/marker
timeline keyed by the stable `sessionId`. Nothing it derives re-enters replayed
state, so inspecting a session can never change it — and re-inspecting the same
journal bytes is byte-identical.

## What it is

`inspectSession(store, sessionId)` reads the latest snapshot + journal tail from a
`StateStore`, decodes each record, and returns a `SessionInspection` —
`governingDigest`, `snapshotUpTo`, the `InspectedRecord[]` timeline, per-kind
`counts`, and a `terminal` of `finished` | `parked` | `open`. The governing
digest is re-derived LOCALLY from the post-snapshot tail (snapshot-safely), so the
package depends on `@irisrun/core` ONLY. `renderTimeline(inspection)` formats it
as one deterministic line per record.

This is the library API — not a CLI. (`iris inspect` is an image-only command.)

## Use it

```ts
import { inspectSession, renderTimeline } from "@irisrun/inspect";

const inspection = await inspectSession(store, "s1");
console.log(renderTimeline(inspection));    // one line per decision/effect/marker
```

See **[docs/Inspecting a session](../../docs/guides/inspect.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
