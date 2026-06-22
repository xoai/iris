// @irisrun/store-mongo certified against the shared store/scheduler conformance suite —
// the same suite memory/fs/do/sqlite run, here against a FAITHFUL in-memory fake driver
// (tests/lib/fake-mongo.ts) whose findOneAndUpdate is atomic in a single tick. The
// {concurrency:8} cases prove the seq-reserve / null-cas gates pick exactly one winner.
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { MongoStateStore, MongoScheduler } from "@irisrun/store-mongo";
import { makeFakeMongo } from "./lib/fake-mongo.ts";

register(
  runStoreConformance(() => new MongoStateStore(makeFakeMongo()), { concurrency: 8 }),
  test,
);
register(runSchedulerConformance(() => new MongoScheduler(makeFakeMongo())), test);
