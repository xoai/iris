# 08 — Audit & reproducible evals

This is the chapter the rest of the funnel was building toward. Everything Iris
does is recorded in a deterministic, event-sourced journal — so "what happened"
isn't a log you hope is complete, it's a **replayable, verifiable record**. That
turns three things from aspirations into commands you can run:

> **deterministic replay → reproducible evals → compliance-grade audit**

It's also the differentiator that survives even if a competitor ships durability
later: determinism is *upstream* of all three, and it's hard to retrofit.

## The one idea: the journal is the audit

A session isn't summarized into an audit log after the fact. The journal **is**
the audit — every effect (model call, tool call, approval, clock read) is an
ordered, checkpointed record written *before* the effect runs. Nothing can run
"around" the record. So an audit is a *projection* of the journal, not a separate
artifact that can drift from reality.

## `iris audit` — read a session's compliance trail

Point it at a session you recorded earlier (e.g. from `iris chat` in chapter 02,
or `iris serve` in chapter 04). It must be a durable store — pass the same
`--db <path>` you ran under:

```sh
iris audit s1 --db s1.sqlite
```

You get the ordered trail (every effect intent/result, every marker, plus the
governed approval trail) and a verification verdict:

```
session s1 | digest sha256:… | terminal finished | snapshot — | 9 record(s) | COMPLETE | 1 approval(s)
  #0 marker marker turn_started
  #1 effect_intent effect tactic (intent …)
  …
approvals:
  #6 c1 rm — APPROVED by alice (intent:approve, authorized:true)
verify: OK (well-formed:true, replay-deterministic:true, total:true)
```

Add `--json` for a machine-readable `{audit, verify}` (for piping into a
compliance pipeline).

## COMPLETE vs PARTIAL — the audit never lies

A long-running session is periodically snapshotted, and by default the journal
*before* a snapshot is truncated to save space. A naive audit that read only the
post-snapshot tail would silently drop everything before the boundary — the worst
possible place to be quietly wrong.

`iris audit` reads the **full retained journal** and tells you the truth:

- **COMPLETE** — the trail goes back to the first event; nothing was dropped.
- **PARTIAL (truncated before #N)** — a snapshot truncated the prefix; the trail
  is only as far back as #N.

Short sessions (under the snapshot threshold) are always COMPLETE. For a
guaranteed-complete trail across a *long* session, the engine must retain history
(`keepHistory`) so nothing is truncated. The point isn't that truncation never
happens — it's that the audit is **loud** about it, never silently partial.

## What `verify` proves (and what it doesn't)

`verify: OK` means three things were checked offline against the recorded journal:

- **well-formed** — the journal is structurally intact: dense, monotonic sequence
  numbers; each record's stored sequence matches its position (tamper/desync
  catch); no duplicate or orphaned effect results.
- **replay-deterministic** — re-folding the recorded records reconstructs the same
  state every time (catches in-process nondeterminism in the reducer).
- **total** — replay runs to completion without error.

Being honest about the boundary: `replay-deterministic` proves the reconstruction
is a pure function of the recorded records *in this process*. It does **not** by
itself prove the run never read a clock or RNG at record time — that is enforced
*online* by Iris's always-on replay-consistency assertion, which runs on **every
live step** and fails loudly the moment live and replay diverge. `verify` also
does not claim snapshot-fidelity (reconstructing the pre-snapshot prefix needs the
original input, which isn't journaled for short sessions). We'd rather ship a
narrow true guarantee than a broad shaky one.

## Reproducible evals

The same determinism makes evals **provably reproducible**, not reproducible-by-
hope. An eval case is a deterministic scenario; `reproduce()` runs it N independent
times and proves byte-identical results — score, status, *and the entire recorded
journal*:

```ts
import { reproduce } from "@iris/evals";

const report = await reproduce(myCase, myScorer, { runs: 3 });
// report.reproducible === true   → every run produced an identical journal
// report.divergence              → if not, the first run + field that differed
```

A real determinism leak (a tactic that sneaks in wall-clock or shared mutable
state) makes `reproducible` go `false` and points at the first divergence — so a
flaky eval is a caught bug, not a mystery.

### From the CLI: `iris eval`

Reproducible evals are also a command. An eval **suite module** exports `cases` and
a `scorer` (it builds each case over `@iris/core` + a store package); point
`iris eval` at it:

```sh
iris eval ./evals/suite.mjs                 # run the suite → one line per case
iris eval ./evals/suite.mjs --reproduce 3   # prove each case byte-identical over 3 runs
```

With `--reproduce N` each line reports `reproducible=<bool>` and the journal digest,
and locates the first divergence (`divergence@<run>:<field>`) when a case isn't
reproducible. Add `--json` for structured output.

## Subagents & schedules (P2-9)

Two more capabilities fall out of the same journaled substrate — both durably
replayable.

**Delegation.** An agent can delegate a sub-task to a *child* agent, which runs in
its own durable session. Declare children in a `subagents.json` beside the agent,
mapping a delegate tool name to a child image:

```json
[{ "name": "delegate", "image": "./children/researcher" }]
```

`iris run`, `iris serve`, and `iris chat` pick it up: when the model calls
`delegate`, the kernel runs the child agent and rides its result back as the tool
result. The child's output is journaled in the parent, so the parent **replays
without re-running the child** — and a recovery re-enters the same deterministic
child session.

**Schedules.** A recurring job parks on durable timers between runs; the cadence
lives in the journal, so the whole schedule replays identically:

```sh
iris schedule ./image --interval 10 --max-runs 3 --db sched.sqlite
```

A host-side pump advances logical time, resumes each due cycle, and confirms a
wakeup only after the turn commits (at-least-once). One effect runs per cycle.

## Why this is hard to copy

Audit, reproducible evals, and cross-host resume aren't three features bolted on —
they're three views of one property: the journal is the source of truth and replay
is deterministic. A system that logs *alongside* execution can always drift from
what really ran. Here, the record **is** the execution. That's the moat.

For the full positioning and status, see the [project README](../README.md)
(this is roadmap item P2-8 — auditability + reproducible evals as the product).

**Next → [Back to the funnel index](./README.md)**
