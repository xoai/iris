# @irisrun/store-mysql

**Run Iris on MySQL / MariaDB.** A host `StateStore` + `Scheduler` certified against
[`@irisrun/store-conformance`](../store-conformance), plugged into the CLI with the
`--store` loader. `mysql2` is a **peer dependency** — you install it — so Iris's own tree
stays zero-dependency.

## Use

```sh
npm i mysql2 @irisrun/store-mysql
iris serve ./image --store @irisrun/store-mysql --db mysql://user:pass@host/agents
```

`--db` carries the connection string (`mysql://…`). The schema (`iris_kv`, `iris_meta`,
`iris_journal`, `iris_snapshot`, `iris_wakeup`) is bootstrapped on first open.

## What it implements

`StateStore` — `cas` (the single-writer lease), an **atomic fenced append** (one
transaction that locks the per-session `iris_meta` row `FOR UPDATE`, checks the fence
before the seq, inserts densely, and bumps the high-water mark that survives truncation),
snapshots, and truncation. `Scheduler` + `WakeupSource` — durable timers and signals with
peek/confirm. Plus `openStore({ url })` for `--store`.

## Certify it against your MySQL

The correctness that matters — atomic fenced append under concurrency — is verified by
running the shared conformance suite against a **live** MySQL:

```sh
IRIS_MYSQL_SMOKE=1 IRIS_MYSQL_URL=mysql://user:pass@host/agents \
  node --conditions=iris-src tests/smoke/store-mysql-smoke.ts
```

A green run means this store upholds the same contract the built-in stores do. (The smoke
is env-gated and not part of `npm test` — like the docker/registry/edge smokes — because
it needs a real database.) Run it before you rely on it in production.
