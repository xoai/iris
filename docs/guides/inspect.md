# Inspecting a session

Your agent ran. It called a tool, paused for approval, picked up again, finished.
Now you want to see **what it actually did** — not a log you hope is complete, but the
exact ordered record of every decision and effect. That record already exists: it's the
session's journal. `inspectSession` reads it back into a timeline you can look at.

> This is a durability runtime, so the journal is the source of truth — see
> [Audit & reproducible evals](../audit-and-evals.md). Inspecting is the *developer's*
> view of that same record: quick, read-only, keyed by `sessionId`.

## Two different "inspects" — don't mix them up

The word **inspect** names two unrelated surfaces in Iris:

| You want to see… | Surface | What it reads |
|---|---|---|
| what's *inside a built image* (its model, tools, capabilities) | `iris inspect ./image` (CLI) | an OCI **image** layout on disk |
| what an *agent did* in a recorded run | `inspectSession(store, id)` (API) | a **session's** snapshot + journal |

`iris inspect ./image` is the CLI command from [Your first agent](../first-agent.md) and
[Tools](../tools.md). Under the hood it calls `cmdInspect` → `inspectImage` — it has
**nothing to do with sessions**. This guide is about the *other* one: `inspectSession`,
exported from `@irisrun/inspect`.

> `inspectSession` is a **library API**, not an `iris` subcommand. You call it from code
> (or it's called for you by `iris audit`, `iris eval`, and the OpenTelemetry exporter —
> all of which build on it).

## The one idea: re-derive the timeline, never re-run it

A session is a snapshot plus a journal of `JournalRecord`s. `inspectSession` reads them,
decodes each one, and summarizes it. It **never writes**, never re-invokes a tactic,
never replays an effect. Nothing it derives re-enters state.

That buys two properties the package leans on:

- **Read-only.** Inspecting a live or finished session can't change it or perturb a
  later replay.
- **Deterministic.** The result is a pure function of the journal bytes. Re-inspecting
  the same store is **byte-identical** — the test proves it by `canonicalize`-ing two
  inspections and asserting they're equal.

## What you get back

`inspectSession(store, sessionId)` returns a `SessionInspection`:

```ts
import { inspectSession, renderTimeline } from "@irisrun/inspect";

const insp = await inspectSession(store, "s1");
```

```ts
interface SessionInspection {
  sessionId: string;
  governingDigest: string | null;   // the pin this session ran under
  snapshotUpTo: number | null;      // last snapshotted seq, or null
  records: InspectedRecord[];       // the timeline (post-snapshot tail)
  counts: { effects; results; markers; decisions };
  terminal: "finished" | "parked" | "open";
}
```

Each `InspectedRecord` carries the raw `seq`, `ts`, `defDigest`, `kind`, the full
`detail` payload, and a one-line `summary`. The `kind` is the record's type:

- `decision` — a tactic was consulted at a seam: `decision <seam> → <tacticId>`.
- `effect_intent` — an effect is about to run: `effect <effectKind> (intent <id>)`,
  flagged `retry-unsafe` when it isn't idempotent.
- `effect_result` — that effect's outcome: `result <id> → ok` or `→ error: <message>`.
- `marker` — a control point: `turn_started`, `wait`, `finish`, `snapshot`, `upgraded`.

So a real harness turn — model call, gated tool, approval, finish — shows up as a chain
of `decision`/`effect_intent`/`effect_result`/`marker` records, in the exact order they
were committed. The test asserts a finished park→resume session yields **6+ records**
with every `effect_intent` paired by an `effect_result` (no dangling effects).

`terminal` is read off the **last** marker: `finish` → `finished`, `wait` → `parked`,
neither → `open`.

## Render it to text

`renderTimeline(insp)` turns the inspection into a deterministic, one-line-per-record
string — a header plus `#<seq> <kind> <summary>` lines:

```
session s1 | digest sha256:… | terminal finished | snapshot — | 9 record(s)
#0 marker marker turn_started
#1 decision decision decideNext → iris/react
#2 effect_intent effect model_call (intent …)
#3 effect_result result … → ok
…
```

Same input, same bytes out — the test asserts `renderTimeline(a) === renderTimeline(b)`
for two inspections of the same store.

## Snapshot-safe by construction

Long sessions get **snapshotted**, and by default the journal *before* the snapshot is
truncated to save space. `inspectSession` handles this honestly:

- It reads the latest snapshot, then reads the journal **from `snapshotUpTo + 1`** — the
  post-snapshot tail. `records[0].seq` is exactly `snapshotUpTo + 1`.
- `governingDigest` is the **last record's** `defDigest`. The terminal marker is
  committed *after* the snapshot seq, so the pin survives truncation — it still resolves
  (it mirrors `pin.ts:latestRecord`). Because it re-derives the pin from the tail alone,
  `@irisrun/inspect` depends on `@irisrun/core` only.

A **never-started** session inspects to a valid empty result — no throw:
`governingDigest: null`, `snapshotUpTo: null`, `records: []`, `terminal: "open"`. And
`renderTimeline` still returns a string.

## Inspect vs audit — pick the right tool

`inspectSession` reads only the **post-snapshot tail**. That's the right scope for a
developer glancing at "what just happened" — fast, recent, enough.

It is **not** the right scope for a compliance trail. An approval that happened *before* a
snapshot boundary is gone from the tail. `iris audit` (over `@irisrun/audit`'s
`auditSession`) instead reads the **full retained journal** from seq 0, and tells you
whether the trail is `COMPLETE` or `PARTIAL (truncated before #N)`. Same journal, wider
read.

> Rule of thumb: **inspect to debug, audit to certify.** When you need the whole story
> back to the first event, reach for [`iris audit`](../audit-and-evals.md), not
> `inspectSession`.

## Where it shows up

`inspectSession` is the shared read primitive under several higher-level surfaces:

- **`iris audit`** notes where the tail would have omitted pre-snapshot approvals, then
  reads the full journal to stay complete.
- **`iris eval`** inspects each case's recorded session to score it and to prove
  byte-identical reproduction.
- The **OpenTelemetry exporter** maps a `SessionInspection` to spans.

One read, four consumers — and every one of them inherits the read-only, deterministic
guarantee for free.

---

Related: [The harness](../harness.md) (the decisions that fill the timeline) ·
[Audit & reproducible evals](../audit-and-evals.md) (the full-journal, certifiable view) ·
[The verifiable journal](../verifiable-journal.md) (the record this all reads).
