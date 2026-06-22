# Never-lose-state agent — crash, restart, migrate

Build an agent that cannot lose its place. Kill the process mid-tool-call, reboot
the host, or move the whole session to a different machine — it resumes exactly
where it was, byte-for-byte. This is the property the rest of Iris is built on;
here's how to rely on it.

> Builds on [Your first agent](../first-agent.md) (resume across a restart) and
> [Verifiable portable journals](../verifiable-journal.md) (the export format).
> This guide is the practical "never lose state" recipe.

## The one idea: a session is its journal on a durable store

An Iris session isn't an object in memory — it's an **event-sourced journal**.
Every decision and effect is appended to a store; the live state is a pure fold of
that log. So "don't lose state" reduces to "use a durable store," and recovery is
automatic: effects are **checkpointed before they run** and are idempotent, so a
crash mid-effect re-performs it **at-least-once** without double-acting, and
replay never re-runs anything already recorded.

You opt into durability by pointing at a real store — that's the whole move:

```sh
iris chat ./image --session s1 --db agent.sqlite     # SQLite on disk = durable & resumable
```

`--db :memory:` (the default for some commands) **warns** — it's ephemeral. A file
path is what makes the session survive the process.

## Crash recovery is free

Start a turn, kill the process partway through, and run the same command again —
it resumes from the journal, not from the top:

```sh
iris chat ./image --session s1 --db agent.sqlite
# ^C mid-turn …
iris chat ./image --session s1 --db agent.sqlite     # picks up exactly where it stopped
```

No special handling, no retries to write. Checkpoint-before-effect plus
idempotency is the contract; a tool that already ran isn't run twice, a model call
already recorded isn't re-issued.

## Move it to another host

A session is portable across **stores**, not just restarts. Export it to a
content-addressed `*.irisjournal`, carry the file anywhere, and import it into a
*different* store — file system, SQLite, or a Cloudflare Durable Object — then
resume byte-identically:

```sh
iris journal export s1 --store agent.sqlite --out s1.irisjournal
# … move s1.irisjournal to the new host …
iris journal import --in s1.irisjournal --store /srv/iris/agent.sqlite
iris journal verify s1.irisjournal --replay --image ./image   # prove it before trusting it
```

`verify` checks the content address (tamper-evident) and, with `--replay`,
re-folds the journal to confirm it reproduces the same state. The end-to-end hop —
laptop (fs) → server (sqlite) → edge (Durable Object), resuming identically at
each stop — is a runnable demo:

```sh
npm run demo:cross-host
```

## Pick the store for the host

The store is the only thing that changes between a laptop, a VPS, and the edge —
the agent and its journal don't:

| Store | Package | Driver (peer dep) | Use it for |
|---|---|---|---|
| Memory | `@irisrun/store-memory` | — (built-in) | tests, `--fake` runs — **not** durable |
| File system | `@irisrun/store-fs` | — (built-in) | a single box, simple persistence |
| SQLite | `@irisrun/store-sqlite` | — (`node:sqlite`) | the default durable local/VPS store (`--db <path>`) |
| Durable Objects | `@irisrun/store-do` | — (Cloudflare) | Cloudflare edge (via `iris deploy`) |
| PostgreSQL | `@irisrun/store-postgres` | `pg` | a shared SQL backend (`--db postgres://…`) |
| MySQL / MariaDB | `@irisrun/store-mysql` | `mysql2` | a shared SQL backend (`--db mysql://…`) |
| Redis | `@irisrun/store-redis` | `redis` | fast KV durability (`--db redis://…`) |
| MongoDB | `@irisrun/store-mongo` | `mongodb` | a document backend (`--db mongodb://…`) |

`memory` · `fs` · `sqlite` are **built-in short names**; the rest **plug & play by module
specifier** — install the driver yourself (Iris's tree stays zero-dependency) and select
the store with `--store`:

```sh
npm i pg @irisrun/store-postgres
iris serve ./image --store @irisrun/store-postgres --db postgres://user@host/agents
# swap the pair for any other: --store @irisrun/store-mysql --db mysql://…  ·  store-redis --db redis://…  ·  store-mongo --db mongodb://…
```

Every one is certified against the same `@irisrun/store-conformance` suite (atomic fenced
append, CAS, snapshot/truncate, durable timers/signals). Because they all implement the
same `StateStore` port, the journal you wrote on one is the journal you read on another —
which is exactly what makes the cross-host move byte-identical. New backend? Any module
exporting `openStore({ url })` works with no fork — see the [stores reference](../stores.md)
and the [adding-a-store recipe](../contributing/adding-a-store.md).

## Going deeper

- [Verifiable portable journals](../verifiable-journal.md) — the export format and
  what verification detects (tamper / reorder / truncate).
- [Deploy](../deploy.md) — resuming the same session on a different host, one
  command to the edge.
- [Auditable agent](./auditable-agent.md) — turn that durable journal into a
  replay-verified compliance record.

---

Related: [Verifiable portable journals](../verifiable-journal.md) · [Your first agent](../first-agent.md) · [Deploy](../deploy.md).
