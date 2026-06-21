// @irisrun/store-sqlite certified against the shared store/scheduler conformance
// suite — the same suite memory/fs/do run. The sqlite-specific atomic-rollback
// (fault injection) test lives in cas.test.ts; everything portable is here.
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";

register(
  runStoreConformance(() => new SqliteStateStore(openDatabase(":memory:")), { concurrency: 8 }),
  test,
);
register(runSchedulerConformance(() => new SqliteScheduler(openDatabase(":memory:"))), test);
