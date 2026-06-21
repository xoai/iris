// @irisrun/store-postgres — a host store on PostgreSQL, plugged into the CLI via
// `--store @irisrun/store-postgres --db postgres://…`. `pg` is a peer dependency.
import { createPool } from "./pg.ts";
import { BOOTSTRAP_DDL } from "./schema.ts";
import { PostgresStateStore } from "./store.ts";
import { PostgresScheduler } from "./scheduler.ts";

export const PACKAGE = "@irisrun/store-postgres";
export { PostgresStateStore } from "./store.ts";
export { PostgresScheduler } from "./scheduler.ts";
export { createPool } from "./pg.ts";
export type { PgPool, PgClient, PgResult } from "./pg.ts";
export { BOOTSTRAP_DDL, TABLES } from "./schema.ts";

/** The CLI `--store` entry point: open a pool, bootstrap the schema, return the ports. */
export async function openStore({ url }: { url: string }): Promise<{
  store: PostgresStateStore;
  scheduler: PostgresScheduler;
  close(): Promise<void>;
}> {
  const pool = await createPool(url);
  for (const stmt of BOOTSTRAP_DDL) await pool.query(stmt);
  return {
    store: new PostgresStateStore(pool),
    scheduler: new PostgresScheduler(pool),
    close: () => pool.end(),
  };
}
