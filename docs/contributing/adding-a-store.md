# Adding a store adapter

A **store adapter** is how you teach Iris to run on a new host backend — Postgres,
Redis, S3, a KV namespace, whatever durably holds bytes — without touching the
kernel and without weakening replay determinism. The core reaches the outside world
through exactly two ports (`packages/core/src/ports.ts`); a host adapter is anything
that implements them. If you haven't read [Architecture](../architecture.md) yet,
start there — it explains why the core stays pure and what the ports buy you. This
page is the contributor recipe for writing your own.

The worked example throughout is `@irisrun/store-memory` — the simplest real port
implementation. It is **not** a test mock: it enforces the same invariants as the
SQLite store (CAS, fencing, a high-water mark that survives truncation), over an
in-memory `Map`. That makes it the clearest place to see the shape. Where the
serverless story differs, we point at `@irisrun/store-fs` (the `node:fs` adapter)
for contrast.

## The one thing to get right: a store stores bytes — it does not decide anything

Before any code, internalize the boundary, because it is what keeps this safe.

A store adapter is **not** a determinism bypass. Replay determinism lives entirely in
core: the engine (`runTurn`) does "acquire lease → replay the journal → recover →
step" and asserts replay consistency after every committed record. The store's only
jobs are (1) to durably hold the journal bytes, the snapshots, and the single-writer
lease, and (2) for the scheduler half, to durably remember a timer or a signal and
let the host wake the agent. The store never interprets a record, never folds state,
never makes a tactic decision. Get the atomicity contract right and replay is correct
*for free* — the same way a domain bundle is replay-safe for free.

What the store **must** enforce is the **atomic fenced append**. That one method is
load-bearing; the rest follow from it.

## Step 1 — Implement `StateStore`

`StateStore` is generic durable bytes plus the journal. Here are the real signatures
you're implementing, from `packages/core/src/ports.ts`:

```ts
export type Version = number; // monotonic per key — the fencing token

export interface StateStore {
  // Generic key/value with compare-and-swap (used for the single-writer lease).
  load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null>;
  cas(
    key: string,
    expected: Version | null,
    next: Uint8Array,
  ): Promise<CasResult>;

  // Journal: atomic, dense, fenced append. The fence check, the expectedSeq
  // check, and the insert MUST be one atomic operation.
  append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult>;
  readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]>;

  // Snapshots: bound replay cost.
  writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void>;
  readLatestSnapshot(
    sessionId: string,
  ): Promise<{ upToSeq: number; bytes: Uint8Array } | null>;
  truncateJournal(sessionId: string, throughSeq: number): Promise<void>;
}
```

The result types are closed unions — return exactly these shapes:

```ts
export type CasResult =
  | { ok: true; version: Version }
  | { ok: false; current: Version };

export type AppendResult =
  | { ok: true; seq: number }
  | { ok: false; reason: "seq_conflict"; currentSeq: number }
  | { ok: false; reason: "stale_fence"; currentFence: Version };
```

### 1a — `cas`: a true compare-and-swap (the lease rides this)

`cas(key, expected, next)` advances a per-key `Version` only if `expected` matches the
current version (`null` means "must not exist yet"). This is what the single-writer
**lease** is built on: `acquireLease` reads the lease key and compare-and-swaps to
claim it, and the new version *is the fence* that tags every subsequent append. So
your `cas` must be a real atomic CAS, not a read-modify-write with a window. In the
memory store it's trivial because JS is single-threaded:

```ts
async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
  const cur = this.kv.get(key);
  const curVer = cur ? cur.version : null;
  if (curVer !== expected) return { ok: false, current: curVer ?? 0 };
  const version = (curVer ?? 0) + 1;
  this.kv.set(key, { bytes: next, version });
  return { ok: true, version };
}
```

On a real concurrent backend you make this atomic with the backend's own primitive —
`store-fs` uses an `O_EXCL` create of `<expected+1>.json` (create-if-not-exists is
atomic on the filesystem), so two acquirers expecting `null` cannot both win. Use a
conditional write, a transaction, or `INSERT … ON CONFLICT` — whatever your backend
gives you for "set only if unchanged."

### 1b — `append`: the atomic, dense, fenced append (the crux)

This is the method everything rests on. The contract, verbatim from `ports.ts`: **the
fence check, the `expectedSeq` check, and the insert MUST be one atomic operation.**
Three guarantees in one indivisible step:

- **Fenced** — reject a write whose `fence` is *below* the highest fence that has ever
  appended. A superseded holder (one whose lease was taken over) is rejected with
  `{ ok: false, reason: "stale_fence", currentFence }`. This is the robust
  fencing-token model: correctness rests on *fencing at write time*, not on holding a
  lock at acquire time.
- **Dense** — `expectedSeq` must be exactly "last seq + 1". A gap or a re-asserted seq
  returns `{ ok: false, reason: "seq_conflict", currentSeq }`. The journal is a
  gap-free monotonic sequence; no holes, no reuse.
- **Atomic insert** — append the records and advance the high-water mark together.

The memory store shows the whole shape:

```ts
async append(
  sessionId: string,
  expectedSeq: number,
  records: Uint8Array[],
  fence: Version,
): Promise<AppendResult> {
  const storedFence = this.fences.get(sessionId) ?? 0;
  if (fence < storedFence) {
    return { ok: false, reason: "stale_fence", currentFence: storedFence };
  }
  // density check uses the high-water mark, NOT MAX(rows) — truncation must
  // not let seq numbers be reused.
  const last = this.hwm.get(sessionId) ?? -1;
  if (last !== expectedSeq - 1) {
    return { ok: false, reason: "seq_conflict", currentSeq: last };
  }
  const j = this.journals.get(sessionId) ?? [];
  let seq = last;
  for (const bytes of records) {
    seq += 1;
    j.push({ seq, bytes });
  }
  this.journals.set(sessionId, j);
  this.hwm.set(sessionId, seq);
  this.fences.set(sessionId, Math.max(storedFence, fence));
  return { ok: true, seq };
}
```

Two subtleties to copy:

- **The density check uses a high-water mark, not `MAX(rows)`.** The hwm is the
  highest seq *ever* appended, and it survives truncation — so after a snapshot
  truncates the journal, a stale writer can't reuse seq `0` again. In the memory store
  that's the `hwm` map; in `store-fs` the hwm is *derived* from the snapshot's
  `upToSeq` plus the gap-free journal prefix above it, so there's no mutable sentinel
  to race.
- **`fence < storedFence` is the only rejection** — an *equal* fence is fine (the same
  holder appending again), and a *higher* fence raises the stored fence. The single
  source-of-truth ordering is "highest fence wins."

On a backend with real concurrency, wrap the read-checks-and-insert in whatever makes
them one atomic unit. `store-fs` does it without a transaction at all: it `O_EXCL`-
creates each record file `<seq>.json` in order, so the create *is* the atomic dense
check — and a multi-record batch that collides mid-way rolls back the files it already
wrote, keeping the append all-or-nothing. A SQL backend would use a transaction with a
fence/seq guard in the `WHERE`. Pick the mechanism your store offers; the *contract* is
fixed.

### 1c — snapshots and truncation (bound replay cost)

`writeSnapshot` / `readLatestSnapshot` / `truncateJournal` let the engine cap how much
journal it must replay. The rules:

- `readLatestSnapshot` returns the snapshot with the **highest** `upToSeq`, or `null`.
- `truncateJournal(sessionId, throughSeq)` drops rows with `seq <= throughSeq`.
- `writeSnapshot` must **seed the high-water mark** to `max(hwm, upToSeq)`. This is the
  migrate-into-an-empty-store contract: migration seeds a destination by writing a
  snapshot at `upToSeq` with an empty journal, and the migrated tail (starting at
  `upToSeq + 1`) must then satisfy the density check. The memory store does this
  explicitly:

```ts
async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
  this.snapshots.set(sessionId, { upToSeq, bytes });
  // Seed the high-water mark so a migrated tail (starting at upToSeq+1) appends densely.
  this.hwm.set(sessionId, Math.max(this.hwm.get(sessionId) ?? -1, upToSeq));
}
```

(In `store-fs` this is implicit — the hwm derives from `snapshotUpTo`, so writing
`snapshots/<upToSeq>` raises it with no extra bookkeeping.)

## Step 2 — Implement `Scheduler`

The second port is durable time and external events. Three methods, real signatures
from `ports.ts`:

```ts
export interface Scheduler {
  sleepUntil(sessionId: string, wakeAt: number): Promise<void>; // durable timer (logical time)
  waitForSignal(sessionId: string, name: string): Promise<void>; // external event
  signal(sessionId: string, name: string, payload?: Uint8Array): Promise<void>;
}
```

`sleepUntil` records a durable timer at a **logical** time (the engine supplies the
clock; the scheduler does not read wall time). `signal` durably records an external
event. `waitForSignal` is intentionally a near-no-op in the reference adapters: the
wait is already recorded in the journal as a marker, and delivery happens through the
host's wake path — so the method exists for parity but persists nothing extra (see the
comments in `memory-scheduler.ts` and `store-fs/src/scheduler.ts`).

The host wake path itself is **not** in the `Scheduler` port — it's an adapter-owned
convention. Both reference schedulers expose a `dueWakeups(now)` that **peeks** due
timers/signals and a `confirmWoken(sessionId, now)` that **consumes** them, and only
*after* the resumed turn has committed (at-least-once wakeup):

```ts
/** PEEK due timers/signals at logical time `now` (no consume). */
dueWakeups(now: number): Wakeup[] { /* ... */ }
/** Consume the wakeups for a session AFTER its resumed turn has committed. */
confirmWoken(sessionId: string, now: number): void { /* ... */ }
```

Peek-then-confirm is what makes a crash between "fired" and "committed" safe: the
wakeup is still due on the next pass. Mirror that shape so a dropped wake can't strand
a parked session. (For a durable host like `store-fs`, the same state lives on disk so
a fresh instance over the same root sees the prior timers/signals — the serverless
cold-start invariant.)

## Step 3 — Pass the cross-store conformance

There is no single `runStoreConformance(store)` helper to call. Conformance is a
**checklist of behaviors**, asserted two ways:

**1. A per-store unit test** that drives your `StateStore` and `Scheduler` directly
through the invariants. The template is `tests/store-memory.test.ts` (the smallest),
with `tests/store-fs.test.ts` as the fuller version and `tests/ports.test.ts` as the
structural baseline. Every store test asserts the same things — copy them against your
adapter:

- `cas`: two writers with the same `expected`, exactly one wins; the loser gets
  `{ ok: false, current }`.
- `append`: rejects a **stale fence** (`reason: "stale_fence"`) and a **seq gap**
  (`reason: "seq_conflict"`), and accepts a dense append.
- truncation: seq numbers are **not reused** after `truncateJournal` (the hwm holds).
- `readJournal`: dense readback that decodes, honoring `fromSeq`.
- scheduler: `dueWakeups` peeks (idempotent), `confirmWoken` consumes.

For a host that needs a concurrency stand-in (like a Durable Object), there's a fixture
pattern too — `tests/store-do-fake.test.ts` drives the adapter against an in-memory
`FakeDoStorage` whose `transaction()` is a *real* serialized mutex, so the atomicity of
your transactional path is actually exercised, not assumed.

**2. The end-to-end cross-store program** (`tests/cross-store-program.ts` +
`tests/cross-store.test.ts`). This is the real proof that your store preserves
determinism: a counted-echo program parks on a timer on **store A** (with a low
`snapshotThreshold` so it snapshots and truncates before parking), is **migrated**
across that snapshot boundary into **store B**, and **resumes** there — and the test
asserts the resumed output *and full canonical state* byte-equal the single-store
baseline:

```ts
// park on A (snapshots + truncates), migrate across the boundary, resume on B
const parked = await runTurn(deps(A, aSched, 0, /* snapshotThreshold */ 2), "x");
const mig = await migrateSession(A, B, "x");
const resumed = await runTurn(deps(B, new MemoryScheduler(), 200, 64), "x");
assert.equal(
  canonicalize(resumedState as Json),
  canonicalize(baselineState as Json),
  "cross-store resumed state must byte-equal the single-store baseline state",
);
```

You drive your adapter the same way: build `EngineDeps` with your `store` and
`scheduler`, run a program with `runTurn`, and check it migrates and resumes
identically against a reference store. If it does, your store stores bytes correctly
*and* the determinism it borrows from core survives the round trip — which is the whole
point.

Finally, export the public surface from a package `index.ts`, the way
`store-memory/src/index.ts` exports `MemoryStateStore` and `MemoryScheduler`.

## Checklist

- [ ] `StateStore` and `Scheduler` are implemented against the real signatures in
      `packages/core/src/ports.ts` — no widened types, no extra core dependency.
- [ ] `cas` is a true atomic compare-and-swap (`expected: null` means "must not
      exist"); the lease rides it.
- [ ] `append` does the **fence check + `expectedSeq` check + insert as ONE atomic
      operation**, returning `stale_fence` / `seq_conflict` / `{ ok, seq }` exactly.
- [ ] The density check uses a **high-water mark that survives truncation** — seq
      numbers are never reused after `truncateJournal`.
- [ ] `writeSnapshot` seeds the hwm to `max(hwm, upToSeq)` (the migrate-into-an-empty-
      store contract).
- [ ] `Scheduler` records durable timers (logical time) and signals; the host wake
      path peeks then consumes only after the resumed turn commits.
- [ ] A per-store test asserts the conformance behaviors (template:
      `tests/store-memory.test.ts`).
- [ ] The cross-store park → migrate → resume test (`tests/cross-store.test.ts`)
      passes against your store — resumed state byte-equals the baseline.
- [ ] The adapter is host-only and lives in its own package; core stays
      byte-untouched and pure.

## See also

- [Architecture](../architecture.md) — pure core behind two ports, why `append` is the
  load-bearing primitive, and where the host boundary sits.
- [Deploy](../deploy.md) — a store adapter in production: `@irisrun/store-do` running
  the durable state on Cloudflare Durable Objects.
