// Pluggable store selection for the CLI. `--store` picks the host store + scheduler:
// a built-in short name (`sqlite` | `fs` | `memory`) or ANY module specifier that
// exports `openStore({ url })` — so a conformant third-party store (e.g.
// `@irisrun/store-postgres`, certified against @irisrun/store-conformance) plugs in
// WITHOUT forking the CLI. Default (no `--store`) is `sqlite` — byte-identical to before.
import type { StateStore, Scheduler } from "@irisrun/core";
import type { WakeupSource } from "@irisrun/schedule";
import type { OpenStore, OpenStoreResult } from "@irisrun/sdk";

// OpenStore / OpenStoreResult are canonical in @irisrun/sdk (the one definition shared
// by the store/provider/channel forkless loaders); re-exported here so existing
// importers keep resolving them from "./store.ts".
export type { OpenStore, OpenStoreResult } from "@irisrun/sdk";

export interface ResolvedStore {
  store: StateStore;
  scheduler: Scheduler & WakeupSource;
  close(): Promise<void>;
}

/** Resolve `--store` (storeSpec) + `--db` (db/url) to a live store + scheduler. */
export async function resolveStore(storeSpec: string | undefined, db: string): Promise<ResolvedStore> {
  const spec = storeSpec ?? "sqlite";

  if (spec === "sqlite") {
    const m = await import("@irisrun/store-sqlite");
    const handle = m.openDatabase(db);
    const store = new m.SqliteStateStore(handle);
    const scheduler = new m.SqliteScheduler(handle);
    return { store, scheduler, close: async () => store.close() };
  }

  if (spec === "fs") {
    const m = await import("@irisrun/store-fs");
    return {
      store: new m.FsStateStore({ root: db }),
      scheduler: new m.FsScheduler({ root: db }),
      close: async () => {},
    };
  }

  if (spec === "memory") {
    if (db !== ":memory:") {
      console.warn(
        "iris: --store memory ignores --db (ephemeral — the session won't persist; use --store sqlite|fs or a durable store)",
      );
    }
    const m = await import("@irisrun/store-memory");
    return { store: new m.MemoryStateStore(), scheduler: new m.MemoryScheduler(), close: async () => {} };
  }

  // Third-party: a module specifier (package name, path, or file:// URL) exporting openStore.
  let mod: { openStore?: OpenStore };
  try {
    mod = (await import(spec)) as { openStore?: OpenStore };
  } catch (e) {
    throw new Error(
      `iris: --store "${spec}" — could not import the store module (${(e as Error).message}). ` +
        "Use a built-in (sqlite|fs|memory) or a module that exports openStore({ url }).",
    );
  }
  if (typeof mod.openStore !== "function") {
    throw new Error(
      `iris: --store "${spec}" must export openStore({ url }) — see docs/contributing/adding-a-store.md`,
    );
  }
  const r = await mod.openStore({ url: db });
  if (!r || typeof r.store !== "object" || typeof r.scheduler !== "object") {
    throw new Error(`iris: --store "${spec}" openStore({ url }) must return { store, scheduler } (got ${typeof r})`);
  }
  return {
    store: r.store,
    scheduler: r.scheduler,
    close: async () => {
      await r.close?.();
    },
  };
}
