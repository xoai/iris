// @irisrun/store-redis — a host store on Redis, plugged into the CLI via
// `--store @irisrun/store-redis --db redis://…`. `redis` (node-redis v4) is a peer
// dependency. No schema step: keys are namespaced under `iris:` and created on demand.
import { createClient } from "./redis.ts";
import { RedisStateStore } from "./store.ts";
import { RedisScheduler } from "./scheduler.ts";

export const PACKAGE = "@irisrun/store-redis";
export { RedisStateStore } from "./store.ts";
export { RedisScheduler } from "./scheduler.ts";
export { createClient, isWatchError } from "./redis.ts";
export type { RedisLike, RedisIsolated, RedisMulti } from "./redis.ts";

/** The CLI `--store` entry point: connect, return the ports (no schema to bootstrap). */
export async function openStore({ url }: { url: string }): Promise<{
  store: RedisStateStore;
  scheduler: RedisScheduler;
  close(): Promise<void>;
}> {
  const redis = await createClient(url);
  return {
    store: new RedisStateStore(redis),
    scheduler: new RedisScheduler(redis),
    close: () => redis.close(),
  };
}
