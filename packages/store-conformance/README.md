# @irisrun/store-conformance

**The importable certification suite for an Iris store.** Iris has exactly two
host ports — `StateStore` and `Scheduler` — and a store is only trustworthy if it
upholds their contracts (linearizable CAS, atomic fenced append, a high-water mark
that survives truncation, the peek→confirm wakeup protocol). This package turns
those contracts into a **runnable suite** you point at any store: pass it and your
store is a correct Iris store; the first-party stores (memory, fs, sqlite, DO) all
run the same suite.

## Use it

The harness is **runner-agnostic** — it returns a list of cases and never imports
a test runner. `register` wires them into `node:test` (or any `(name, fn)` runner),
so a third-party store certifies itself in its own CI:

```ts
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { MyStateStore, MyScheduler } from "./my-store.ts";

register(runStoreConformance(() => new MyStateStore()), test);
register(runSchedulerConformance(() => new MyScheduler()), test);
```

`runStoreConformance(make, { concurrency })` accepts an opt-in real-concurrency
stress (default off): with `concurrency: 8` it fires eight racers at the same CAS
and the same append and asserts **exactly one wins** — where a racy or
eventually-consistent backend breaks.

## What you must provide

Conformance certifies the in-process port contract. It assumes — and **requires** —
that your backend gives **linearizable compare-and-swap** and an **atomic, fenced,
dense append** (the fence check + the expectedSeq check + the insert are one atomic
operation). Eventual consistency is insufficient unless fronted by a strongly
consistent path. Durability across a cold process/instance is **backing-specific**
(reopen over the same directory / connection) — see the fs and DO stores for the
reference pattern; it is not part of the portable suite.

See `docs/contributing/adding-a-store.md` for the full recipe.
