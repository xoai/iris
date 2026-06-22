# @irisrun/store-mongo

**Run Iris on MongoDB.** A host `StateStore` + `Scheduler` certified against
[`@irisrun/store-conformance`](../store-conformance), plugged into the CLI with the
`--store` loader. `mongodb` is a **peer dependency** — you install it — so Iris's own tree
stays zero-dependency.

## Use

```sh
npm i mongodb @irisrun/store-mongo
iris serve ./image --store @irisrun/store-mongo --db mongodb://host:27017/agents
```

`--db` carries the connection string (`mongodb://…`); the database name comes from the URL
(default `iris`). Collections (`iris_kv`, `iris_meta`, `iris_journal`, `iris_snapshot`,
`iris_wakeup`) are created on demand.

## What it implements

`StateStore` — `cas` (the single-writer lease) and an **atomic fenced append**. The append
rests on MongoDB **single-document atomicity** of the per-session `iris_meta` doc: a
guarded `findOneAndUpdate` reserves the dense seq range (fence checked first, with
precedence), then the journal docs are inserted. No multi-document transaction (so **no
replica set is required**). The high-water mark survives truncation.

> **Crash-atomicity tier.** The reservation and the journal insert are two operations, not
> one transaction. A process crash *between* them advances the hwm while leaving those
> journal rows missing — a gap. This is never silent: Iris asserts replay consistency on
> every step, so a gap surfaces as a **loud** replay failure (operator intervention),
> never wrong state. The transactional SQL stores (`store-postgres`/`store-mysql`) have no
> such window — prefer one of them, or a replica-set transaction (a future opt-in), when
> strict crash-atomicity matters.

`Scheduler` +
`WakeupSource` — durable timers and signals with peek/confirm. Plus `openStore({ url })`
for `--store`.

## Certify it against your MongoDB

The correctness that matters — atomic fenced append under concurrency — is verified by
running the shared conformance suite against a **live** MongoDB:

```sh
IRIS_MONGO_SMOKE=1 IRIS_MONGO_URL=mongodb://host:27017/agents \
  node --conditions=iris-src tests/smoke/store-mongo-smoke.ts
```

A green run means this store upholds the same contract the built-in stores do. (The smoke
is env-gated and not part of `npm test`, because it needs a real server. The in-tree
`tests/store-mongo-conformance.test.ts` runs the same suite against a faithful in-memory
fake.) Run the smoke before you rely on it in production.
