# @irisrun/store-redis

**Run Iris on Redis.** A host `StateStore` + `Scheduler` certified against
[`@irisrun/store-conformance`](../store-conformance), plugged into the CLI with the
`--store` loader. `redis` (node-redis v4) is a **peer dependency** — you install it — so
Iris's own tree stays zero-dependency.

## Use

```sh
npm i redis @irisrun/store-redis
iris serve ./image --store @irisrun/store-redis --db redis://host:6379
```

`--db` carries the connection string (`redis://…`). Keys are namespaced under `iris:` and
created on demand (no schema step).

## What it implements

`StateStore` — `cas` (the single-writer lease) and an **atomic fenced append**, both made
atomic with a Redis **optimistic transaction** (`WATCH` the per-session meta key →
read/guard → `MULTI`/`EXEC`; a concurrent writer's commit fails the `EXEC` with a
`WatchError`, so exactly one writer wins). The journal/snapshot/meta live in Redis hashes
(byte payloads base64-encoded); the high-water mark survives truncation. `Scheduler` +
`WakeupSource` — durable timers and signals with peek/confirm. Plus `openStore({ url })`
for `--store`.

## Certify it against your Redis

The correctness that matters — atomic fenced append under concurrency — is verified by
running the shared conformance suite against a **live** Redis:

```sh
IRIS_REDIS_SMOKE=1 IRIS_REDIS_URL=redis://host:6379 \
  node --conditions=iris-src tests/smoke/store-redis-smoke.ts
```

A green run means this store upholds the same contract the built-in stores do. (The smoke
is env-gated and not part of `npm test`, because it needs a real server. The in-tree
`tests/store-redis-conformance.test.ts` runs the same suite against a faithful in-memory
fake.) Run the smoke before you rely on it in production.
