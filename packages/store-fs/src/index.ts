// @irisrun/store-fs — public surface (host; serverless cold-per-turn over node:fs).
export const PACKAGE = "@irisrun/store-fs";

export { FsStateStore } from "./store.ts";
export type { FsStoreOptions } from "./store.ts";

export { FsScheduler } from "./scheduler.ts";
export type { Wakeup } from "./scheduler.ts";
