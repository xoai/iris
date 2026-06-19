// @iris/store-sqlite — host adapter surface.
export const PACKAGE = "@iris/store-sqlite";
export { openDatabase, SqliteStateStore } from "./sqlite-state-store.ts";
export { SqliteScheduler } from "./sqlite-scheduler.ts";
export type { Wakeup } from "./sqlite-scheduler.ts";
export { applySchema, SCHEMA_SQL } from "./schema.ts";
