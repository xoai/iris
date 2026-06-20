# @irisrun/core

**The pure durability engine — own your state as a journal that replays
byte-for-byte.** `runTurn` drives one turn over an append-only journal:
acquire-lease → replay → recover → step/effect/wait/finish, checkpoint *before*
every effect, and re-run replay after every committed step to assert the
reconstruction byte-equals live state. No I/O of its own — the store, scheduler,
clock, and performers are all injected — and it imports no host, transport, or
Node-only API, so the *same* engine runs unchanged on a server or the edge.

## What it is

The journal is the single source of truth (`JournalRecord`); state is the
result of replaying it (`replay` + `Reducer`). `assertReplayConsistency` is the
always-on defense against determinism bugs — it throws `ReplayDivergenceError`
on any divergence, never a silent pass (the engine decides *whether* to call it;
the assertion always asserts). The effect engine journals an intent, performs
it, and journals the result, so recovery and replay reuse the same machinery.
A single-writer lease over `StateStore.cas` returns a monotonic `Version` — the
**fence** — and mutual exclusion is enforced by fencing (a taken-over holder is
rejected at `append` with `stale_fence`), not by acquire-time locking.
`shouldSnapshot` / `migrateSession` bound replay cost and move sessions forward.
Everything rides two ports — `StateStore` and `Scheduler` — that host adapters
implement. The harness layer adds a pure agent loop: `harnessProgram` (a kernel
encoded as a `Program<HarnessState>` over the *unchanged* `runTurn`), composable
seams (`composeGate` / `composeDecideNext` / `composeAssemble`), and a
`defaultBundle` of tactics — a seam consultation is journaled as a `tactic`
effect, so replay never re-invokes a tactic.

## Use it

Library-only (no CLI). Implement the two ports for your host, register your
performers, and call `runTurn`; the harness kernel and `defaultBundle` give you
a ready agent loop.

See **[docs/Architecture](../../docs/architecture.md)** and
**[docs/Introduction](../../docs/introduction.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
