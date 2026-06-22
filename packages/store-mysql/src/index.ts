// @irisrun/store-mysql — a host store on MySQL/MariaDB, plugged into the CLI via
// `--store @irisrun/store-mysql --db mysql://…`. `mysql2` is a peer dependency.
import { createPool } from "./mysql.ts";
import { BOOTSTRAP_DDL } from "./schema.ts";
import { MysqlStateStore } from "./store.ts";
import { MysqlScheduler } from "./scheduler.ts";

export const PACKAGE = "@irisrun/store-mysql";
export { MysqlStateStore, versionedCasResult } from "./store.ts";
export { MysqlScheduler } from "./scheduler.ts";
export { createPool, rowsOf, headerOf, isDuplicateKey } from "./mysql.ts";
export type { MysqlPool, MysqlConn, MysqlResultHeader } from "./mysql.ts";
export { BOOTSTRAP_DDL, TABLES } from "./schema.ts";

/** The CLI `--store` entry point: open a pool, bootstrap the schema, return the ports. */
export async function openStore({ url }: { url: string }): Promise<{
  store: MysqlStateStore;
  scheduler: MysqlScheduler;
  close(): Promise<void>;
}> {
  const pool = await createPool(url);
  for (const stmt of BOOTSTRAP_DDL) await pool.query(stmt);
  return {
    store: new MysqlStateStore(pool),
    scheduler: new MysqlScheduler(pool),
    close: () => pool.end(),
  };
}
