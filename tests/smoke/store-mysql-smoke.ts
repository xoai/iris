// Env-gated live-MySQL certification for @irisrun/store-mysql. Runs the SAME
// @irisrun/store-conformance cases the built-in stores pass, against a REAL MySQL/MariaDB —
// so a green run = a certified store. Outside `npm test` (tests/smoke/** is excluded from
// the suite + typecheck), like the docker / registry / postgres smokes, because it needs a
// live database and the `mysql2` peer dependency installed.
//
//   IRIS_MYSQL_SMOKE=1 IRIS_MYSQL_URL=mysql://user:pass@host/db \
//     node --conditions=iris-src tests/smoke/store-mysql-smoke.ts
import { runStoreConformance, runSchedulerConformance } from "@irisrun/store-conformance";
import { MysqlStateStore, MysqlScheduler, createPool, BOOTSTRAP_DDL, TABLES } from "@irisrun/store-mysql";

const url = process.env.IRIS_MYSQL_URL;
if (process.env.IRIS_MYSQL_SMOKE !== "1" || !url) {
  console.log("store-mysql smoke: set IRIS_MYSQL_SMOKE=1 and IRIS_MYSQL_URL=mysql://… (and `npm i mysql2`) to run.");
  process.exit(0);
}

const pool = await createPool(url);

async function reset(): Promise<void> {
  for (const t of TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
  for (const stmt of BOOTSTRAP_DDL) await pool.query(stmt);
}

// Each conformance case wants a CLEAN store; MySQL is a shared DB, so truncate first.
async function freshStore(): Promise<MysqlStateStore> {
  for (const t of TABLES) await pool.query(`TRUNCATE ${t}`);
  return new MysqlStateStore(pool);
}
async function freshScheduler(): Promise<MysqlScheduler> {
  await pool.query("TRUNCATE iris_wakeup");
  return new MysqlScheduler(pool);
}

await reset();
const cases = [
  ...runStoreConformance(freshStore, { concurrency: 8 }),
  ...runSchedulerConformance(freshScheduler),
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${c.name}: ${(e as Error).message}`);
  }
}
await pool.end();
console.log(`\nstore-mysql smoke: ${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
