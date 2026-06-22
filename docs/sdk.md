# The adapter SDK (`@irisrun/sdk`)

Iris reaches the outside world through a few narrow **ports**. An *adapter* implements one:
a **store** (durable bytes — the journal + the single-writer lease), a **channel** (a wire in
front of a durable session), or a **provider** (a model backend). `@irisrun/sdk` is **one
dependency** that gives you everything to build one, and the matching CLI loader runs it
**without forking Iris**.

> **In-process, TypeScript.** Store and provider adapters run *inside* the Node host, so they
> are TypeScript/JS (WASM-reachable) — not Go or Python. For genuinely cross-language
> extension Iris already has the right seams: **tools** are referenced by address and run in
> any language (see [Tools](./tools.md)), and a non-first-party **channel** is a
> [bridge](./reference/bridge-pattern.md) — an external process speaking the REST wire. The
> SDK makes *in-process TypeScript* adapter authoring easy.

## Adapter or bridge? (the word "adapter" is overloaded)

Two different things, often both called "adapter" — this is the usual point of confusion:

| | **Port adapter** (this SDK) | **Bridge** |
| --- | --- | --- |
| **Reaches** | one of Iris's **ports** | a non-first-party **platform** (Discord, Telegram, WhatsApp, …) |
| **Kinds** | `store` · `channel` · `provider` | one per platform |
| **Runs** | **inside** the Iris runtime (TypeScript) | **outside** Iris, any language — speaks only the REST channel **wire protocol** |
| **Implements** | a typed core port + a conformance suite | nothing of Iris's — it translates webhook ↔ wire |
| **Ships as** | a package (`@irisrun/store-mysql`) | a **reference example** you copy & adapt |
| **Selected with** | `--store` / `--channel` / `--provider <module>` | `iris bridge <module>` |
| **Scaffold** | `iris adapter init <store\|channel\|provider>` | copy `examples/bridges/<x>.ts` |

The trap: a **bridge internally uses a "platform adapter"** — the `verify` / `parse` /
`formatReply` triple (`@irisrun/bridge`'s `PlatformAdapter`). That is **not** an Iris port
adapter; it's the platform-specific glue inside a bridge. So "adapter" means a *port adapter*
at the Iris level and a *platform adapter* inside a bridge — different layers.

**Rule of thumb.** Implementing a **port** (a new DB backend, a new in-process transport, a
new model vendor) → a **port adapter**, this SDK, loaded with `--store`/`--channel`/`--provider`.
Reaching a **chat platform** Iris doesn't own → a **bridge**, run with `iris bridge` (see the
[bridge pattern](./reference/bridge-pattern.md)). The one exception: **Slack** is a first-party
channel *adapter*, not a bridge — it's the platform chosen to demonstrate the durable-HITL moat;
every other platform is a bridge.

## What it gives you

| Family | Port you implement | Conformance suite | Forkless loader |
| --- | --- | --- | --- |
| **store** | `StateStore` + `Scheduler` | `runStoreConformance` / `runSchedulerConformance` | `--store <module>` → `openStore` |
| **channel** | `ChannelPort` (drive `makeChannelSession`) | `runChannelPortConformance` | `--channel <module>` → `openChannel` |
| **provider** | a `model_call` `Performer` | `runModelProviderConformance` | `--provider <module>` → `openModelProvider` |

Everything comes from one import: the port types, the three conformance runners + a single
`register`, and the three loader **contracts** (`OpenStore` / `OpenProvider` / `OpenChannel`).

## Scaffold one

```sh
iris adapter init store my-store      # or: channel | provider
cd my-store
npm install && npm test               # runs the conformance suite
```

The scaffold is a buildable package already wired to `@irisrun/sdk` and the matching suite.
The **store** scaffold ships a minimal *correct* in-memory store, so its suite is **green out
of the box** — you start by swapping the in-memory `Map`s for your backend. The **channel** and
**provider** scaffolds ship the port shape with marked `TODO`s (a green stub there would be a
full transport / a full vendor performer you'd then delete). `iris adapter init` refuses a
non-empty target (no-clobber).

## The three contracts

A forkless adapter exports ONE factory. The CLI dynamic-imports it — so it adds **no dependency**
to Iris; your driver (the Postgres client, the gRPC server, the vendor SDK) is *your* dependency —
and a module that is missing the export or returns the wrong shape is refused **loudly**.

```ts
import type { OpenStore, OpenProvider, OpenChannel } from "@irisrun/sdk";

export const openStore: OpenStore = ({ url }) => ({ store, scheduler });          // --store <module>
export const openModelProvider: OpenProvider = () => ({ buffered, streaming });   // --provider <module>
export const openChannel: OpenChannel = (opts) => ({ listen, close });            // --channel <module>
```

Certify it with the suite — it **returns cases** and imports no test runner, so `register`
wires them into `node:test` (or any `(name, fn)` runner):

```ts
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/sdk";

register(runStoreConformance(() => new MyStore()), test);
register(runSchedulerConformance(() => new MyScheduler()), test);
```

Passing the suite **is** the definition of a correct adapter.

## Load it (no fork)

```sh
iris run   ./image --store    @acme/iris-store-redis  --db redis://localhost
iris serve ./image --provider @acme/iris-provider-foo --model foo/whatever
iris serve ./image --channel  @acme/iris-channel-grpc
```

The default (no flag) is byte-identical to before: `--store` defaults to `sqlite`, the model
provider comes from the image's `<provider>/` prefix, and the channel is the built-in `rest`
transport. `iris deploy` bakes a **built-in** provider into the generated worker, so forkless
`--provider` / `--channel` are `run` / `serve` / `chat`-only (deploy refuses them loudly).

## The long-form recipes

Each family has a deep contributor recipe — the port contract, the worked example, the
load-bearing step, and the conformance suite that defines "done":

- [Add a store](./contributing/adding-a-store.md) — the atomic fenced append, the CAS lease, snapshots.
- [Add a channel](./contributing/adding-a-channel.md) — the two-identifier protocol, the refusal taxonomy.
- [Add a provider](./contributing/adding-a-provider.md) — request shaping + reply canonicalization for replay.

See also [Architecture](./architecture.md) (the pure core behind the ports) and the
[CLI reference](./reference/cli.md) (`iris adapter init`, `--store` / `--provider` / `--channel`).
