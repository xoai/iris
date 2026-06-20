# @irisrun/store-sqlite

**The long-running host — the reference adapter.** A `node:sqlite`
(`DatabaseSync`) adapter that enforces the **same** CAS / fencing /
high-water-mark / snapshot invariants as the fs, memory, and DO stores — the
invariants that make replay byte-identical — for a held process that keeps a
single durable file open across turns. Owning state as a portable journal is
what makes "resume anywhere" real; this is the *anywhere* you run all day.

## What it is

`SqliteStateStore` + `SqliteScheduler` implement the two ports
(`StateStore` + `Scheduler`) over a synchronous SQLite database. `cas` is a real
compare-and-swap on the `kv` version; `append` runs the fence check, the
expected-seq check, the inserts, and the fence bump inside **one
`BEGIN IMMEDIATE` transaction** — no interleave window, rolled back on any
failure. The density check reads `journal_hwm`, a high-water mark that
**survives truncation** so seq numbers are never reused; `writeSnapshot` seeds it
via `MAX(...)` so a migrated tail passes that check. `SqliteScheduler` persists
timers/signals so a restarted process re-arms them — `dueWakeups` peeks,
`confirmWoken` consumes only after the resumed turn commits (at-least-once).
`openDatabase` / `applySchema` create the idempotent schema; node:sqlite is
Node-only, so this lives in a host adapter, never in core.

## Use it

```ts
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";

const db = openDatabase("./session.db");
const store = new SqliteStateStore(db);
const scheduler = new SqliteScheduler(db);
```

See **[docs/Architecture](../../docs/architecture.md)** and **[docs/Deploy](../../docs/deploy.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
