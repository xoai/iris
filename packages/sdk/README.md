# @irisrun/sdk

One dependency to author an Iris **adapter** — a store, a channel, or a provider.
It re-exports, from a single import:

- the **port types** for all three families (`StateStore`/`Scheduler`, the channel
  port + `makeChannelSession`, `Performer` + `ModelCall*`);
- the three importable **conformance suites** (`runStoreConformance`,
  `runChannelPortConformance`, `runModelProviderConformance`) + a single `register`;
- the **forkless-loader contracts** an adapter package exports so the CLI can load it
  without a fork — `OpenStore` (`openStore`), `OpenProvider` (`openModelProvider`),
  `OpenChannel` (`openChannel`).

It has **no runtime logic of its own** — it is a curated surface, and it does **not**
depend on the CLI.

```ts
// a third-party store, certified and forkless-loadable:
import { type OpenStore, runStoreConformance, runSchedulerConformance, register } from "@irisrun/sdk";
import { test } from "node:test";

export const openStore: OpenStore = ({ url }) => ({ store: /* … */, scheduler: /* … */ });
register(runStoreConformance(() => new MyStore()), test);
```

Scaffold a ready-to-fill package with `iris adapter init <store|channel|provider> <name>`.
See the contributor recipes: [store](../../docs/contributing/adding-a-store.md) ·
[channel](../../docs/contributing/adding-a-channel.md) ·
[provider](../../docs/contributing/adding-a-provider.md).
