// @irisrun/store-memory certified against the shared store/scheduler conformance
// suite (@irisrun/store-conformance) — the SAME suite fs/sqlite/do run. The whole
// port contract lives in the suite now; this file is just the registration plus an
// opt-in real-concurrency pass (memory is single-threaded, so it confirms
// serialized behaviour). The old hand-written assertions moved into the suite
// 1:1 (see the M1 assertion-mapping table) — no coverage was dropped.
import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/store-conformance";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

register(runStoreConformance(() => new MemoryStateStore(), { concurrency: 8 }), test);
register(runSchedulerConformance(() => new MemoryScheduler()), test);
