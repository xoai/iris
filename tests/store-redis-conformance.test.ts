// @irisrun/store-redis certified against the shared store/scheduler conformance suite —
// the same suite memory/fs/do/sqlite run. It runs against a faithful in-memory fake
// (tests/lib/fake-redis.ts) whose WATCH/MULTI/EXEC semantics mirror node-redis v4
// (exec() throws a WatchError when a watched key moved), so the {concurrency:8}
// "exactly one wins" cases exercise the real optimistic-transaction code path.
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { RedisStateStore, RedisScheduler } from "@irisrun/store-redis";
import { makeFakeRedis } from "./lib/fake-redis.ts";

register(
  runStoreConformance(() => new RedisStateStore(makeFakeRedis()), { concurrency: 8 }),
  test,
);
register(runSchedulerConformance(() => new RedisScheduler(makeFakeRedis())), test);
