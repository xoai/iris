# @irisrun/store-fs

**The serverless host that proves portability across machines.** A `node:fs`
adapter that holds **no long-lived handle** — every method opens, reads/writes,
and returns, so a *fresh* instance over the same root behaves identically to a
reused one (the cold-per-turn invariant). It enforces the **same** CAS / fencing
/ high-water-mark / snapshot invariants as the sqlite, memory, and DO stores —
the invariants that make replay byte-identical — so the same image resumes the
same session on a different machine by construction. This is **host B** for the
cross-host portability proof.

## What it is

`FsStateStore` + `FsScheduler` implement the two ports
(`StateStore` + `Scheduler`) over atomic filesystem primitives. CAS is an
`O_EXCL` create of `<expected+1>.json` — a true atomic decision point, no
read-modify-write window — and `append` is fenced and dense via the same
`O_EXCL` check, with all-or-nothing rollback. The hwm is *derived* from the
snapshot + journal directory (no mutable sentinel to race), and `writeSnapshot`
seeds it by raising `snapshots/<upToSeq>`. `FsScheduler` keeps timers/signals as
durable files under `_wake/`, so a cold instance sees prior wakeups; `dueWakeups`
peeks, `confirmWoken` consumes only after the resumed turn commits. Node-only, so
it lives in a host adapter, never in core. **Not a determinism bypass** — it is a
real port impl.

## Use it

```sh
node --conditions=iris-src examples/portability-demo.ts   # resume on a different host
```

See **[docs/Deploy](../../docs/deploy.md)** and **[docs/Architecture](../../docs/architecture.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
