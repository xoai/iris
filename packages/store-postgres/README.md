# @irisrun/store-postgres

**Run Iris on PostgreSQL.** A host `StateStore` + `Scheduler` certified against
[`@irisrun/store-conformance`](../store-conformance), plugged into the CLI with the
`--store` loader. `pg` is a **peer dependency** — you install it — so Iris's own tree
stays zero-dependency.

## Use

```sh
npm i pg @irisrun/store-postgres
iris serve ./image --store @irisrun/store-postgres --db postgres://user@host/agents
```

`--db` carries the connection string. The schema (`iris_kv`, `iris_meta`,
`iris_journal`, `iris_snapshot`, `iris_wakeup`) is bootstrapped on first open.

## What it implements

`StateStore` — `cas` (the single-writer lease), an **atomic fenced append** (one
transaction that locks the per-session `iris_meta` row `FOR UPDATE`, checks the fence
before the seq, inserts densely, and bumps the high-water mark that survives
truncation), snapshots, and truncation. `Scheduler` + `WakeupSource` — durable timers
and signals with peek/confirm. Plus `openStore({ url })` for `--store`.

## Certify it against your Postgres

The correctness that matters — atomic fenced append under concurrency — is verified
by running the shared conformance suite against a **live** Postgres:

```sh
IRIS_PG_SMOKE=1 IRIS_PG_URL=postgres://user@host/agents \
  node --conditions=iris-src tests/smoke/store-postgres-smoke.ts
```

A green run means this store upholds the same contract the built-in stores do. (The
smoke is env-gated and not part of `npm test` — like the docker/registry/edge smokes —
because it needs a real database.) Run it before you rely on it in production.
