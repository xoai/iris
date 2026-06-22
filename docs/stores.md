# Stores — durability backends

A **store** is where a session's journal lives. It's one of Iris's two host ports: durable
bytes (the journal + snapshots + the single-writer lease) plus a **scheduler** (durable
timers and signals). The agent and its journal never change between hosts — **only the store
does**, which is exactly what makes a session portable from a laptop to a VPS to the edge.

This is the store-side counterpart to [Channels](./channels.md): pick a backend, plug it in,
done. (Channels are how a *human* reaches the session; stores are where the session *lives*.)

## Plug & play: `--store <name|module> --db <url>`

`memory` · `fs` · `sqlite` are **built-in short names**. Every other backend is a
**peer-dependency-only package** you select by module specifier — install the driver
yourself (so Iris's own tree stays zero-dependency) and pass its connection string as `--db`:

```sh
npm i pg @irisrun/store-postgres                 # the driver is YOURS; Iris adds none
iris serve ./image --store @irisrun/store-postgres --db postgres://user@host/agents
```

| Store | Package | Driver (peer dep) | `--db` / use it for |
|---|---|---|---|
| Memory | `@irisrun/store-memory` | — (built-in) | `:memory:` — tests, `--fake` runs (**not** durable) |
| File system | `@irisrun/store-fs` | — (built-in) | a directory — a single box, simple persistence |
| SQLite | `@irisrun/store-sqlite` | — (`node:sqlite`) | a file path — the default durable local/VPS store |
| Durable Objects | `@irisrun/store-do` | — (Cloudflare) | the edge (via `iris deploy`) |
| PostgreSQL | `@irisrun/store-postgres` | `pg` | `postgres://…` — a shared SQL backend |
| MySQL / MariaDB | `@irisrun/store-mysql` | `mysql2` | `mysql://…` — a shared SQL backend |
| Redis | `@irisrun/store-redis` | `redis` | `redis://…` — fast KV durability |
| MongoDB | `@irisrun/store-mongo` | `mongodb` | `mongodb://…` — a document backend |

The same `--store <module>` selection works on `run` / `serve` / `chat` / `audit` /
`schedule`. A module that can't be imported, lacks `openStore`, or whose driver isn't
installed is refused **loudly** (naming the install command). Full flag detail: the
[CLI reference](./reference/cli.md#run--serve).

## One contract, one conformance suite

Every store — built-in or third-party — implements the same `StateStore` + `Scheduler`
ports and passes the **same** importable suite, `@irisrun/store-conformance`. That suite is
the definition of "a correct store": an **atomic fenced append** (the fence check + the
dense-sequence check + the insert are one indivisible step), a real compare-and-swap (the
single-writer lease rides it), a high-water mark that survives truncation, snapshot/restore,
and the peek→confirm wakeup protocol — including an opt-in concurrency stress that fails a
racy backend. Because they all uphold one contract, the journal you wrote on one store is the
journal you read on another: the cross-host move is **byte-identical** (see
[Never-lose-state agent](./guides/portable-durable-agent.md) and [Deploy](./deploy.md)).

How the shipped stores meet it, by substrate:

- **SQL** (`store-postgres`, `store-mysql`) — one transaction that locks the per-session meta
  row `FOR UPDATE`, checks the fence before the sequence, inserts densely, and bumps the hwm.
- **KV** (`store-redis`) — an optimistic transaction: `WATCH` the meta key → guard → `MULTI`/
  `EXEC`; a concurrent commit fails `EXEC` with a `WatchError`, so exactly one writer wins.
- **Document** (`store-mongo`) — single-document atomicity of the meta doc: a guarded
  `findOneAndUpdate` reserves the dense range (fence first), then the journal docs are
  inserted (no multi-document transaction — and so a slightly lower crash-atomicity tier than
  the SQL stores; the engine's per-step replay assertion turns any gap into a *loud* failure,
  never silent corruption — see its README).

## Build your own

Any module exporting `openStore({ url }) → { store, scheduler, close? }` plugs in with no
fork. Scaffold one with `iris adapter init store <name>` (its conformance suite is green out
of the box over an in-memory `Map` — swap in your backend), and read the contributor recipe
[Add a store](./contributing/adding-a-store.md). On adapters vs bridges, see
[the adapter SDK](./sdk.md#adapter-or-bridge-the-word-adapter-is-overloaded).

**Next → [Deploy](./deploy.md)**
