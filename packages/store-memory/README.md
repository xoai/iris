# @irisrun/store-memory

**The fast in-memory host — a real store, not a stub.** A `Map`-backed adapter
that enforces the **same** CAS / fencing / high-water-mark / snapshot invariants
as the sqlite, fs, and DO stores — the invariants that make replay
byte-identical. It is the **fast unit store** that keeps the test suite quick,
and **store B** for the cross-store resume proof: a session started on one store
resumes here from the same journal, byte-for-byte. Owning state as a portable
journal is what makes "resume anywhere" real; this is the cheapest *anywhere*.

## What it is

`MemoryStateStore` + `MemoryScheduler` implement the two ports
(`StateStore` + `Scheduler`) over in-process maps — **no test backdoors**, a
production port impl the brief sanctions "as a port impl that still enforces
CAS." `cas` is a true compare-and-swap on the kv/lease version; `append` is
atomic, fenced, and dense, and the density check reads a high-water mark that
**survives truncation** so seq numbers are never reused; `writeSnapshot` seeds
that hwm so a migrated tail still passes the density check. `MemoryScheduler`
mirrors the durable schedulers' at-least-once semantics — `dueWakeups` peeks,
`confirmWoken` consumes only after the resumed turn commits. **Not a determinism
bypass** — same invariants, same conformance suite, just no disk.

## Use it

```ts
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

const store = new MemoryStateStore();
const scheduler = new MemoryScheduler();
```

See **[docs/Architecture](../../docs/architecture.md)** and **[docs/Deploy](../../docs/deploy.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
