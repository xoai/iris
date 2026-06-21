// @irisrun/store-conformance — the importable certification suite for the two
// Iris host ports. A store/scheduler that passes it is a correct Iris store.
export const PACKAGE = "@irisrun/store-conformance";
export { runStoreConformance } from "./store.ts";
export { runSchedulerConformance } from "./scheduler.ts";
export { register } from "./register.ts";
export type {
  ConformanceCase,
  StoreFactory,
  SchedulerFactory,
  SchedulerUnderTest,
  Wakeup,
  WakeupSource,
  StoreConformanceOpts,
} from "./types.ts";
