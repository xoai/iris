// Env-gated live-Postgres certification for @irisrun/store-postgres. Runs the SAME
// @irisrun/store-conformance cases the built-in stores pass, against a REAL Postgres —
// so a green run = a certified store. Outside `npm test` (tests/smoke/** is excluded
// from the suite + typecheck), like the docker / registry / edge smokes, because it
// needs a live database and the `pg` peer dependency installed.
//
//   IRIS_PG_SMOKE=1 IRIS_PG_URL=postgres://user@host/db \
//     node --conditions=iris-src tests/smoke/store-postgres-smoke.ts
import { runStoreConformance, runSchedulerConformance } from "@irisrun/store-conformance";
import { PostgresStateStore, PostgresScheduler, createPool, BOOTSTRAP_DDL, TABLES } from "@irisrun/store-postgres";

const url = process.env.IRIS_PG_URL;
if (process.env.IRIS_PG_SMOKE !== "1" || !url) {
  console.log("store-postgres smoke: set IRIS_PG_SMOKE=1 and IRIS_PG_URL=postgres://… (and `npm i pg`) to run.");
  process.exit(0);
}

const pool = await createPool(url);

async function reset(): Promise<void> {
  for (const t of TABLES) await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  for (const stmt of BOOTSTRAP_DDL) await pool.query(stmt);
}

// Each conformance case wants a CLEAN store; Postgres is a shared DB, so truncate first.
async function freshStore(): Promise<PostgresStateStore> {
  for (const t of TABLES) await pool.query(`TRUNCATE ${t}`);
  return new PostgresStateStore(pool);
}
async function freshScheduler(): Promise<PostgresScheduler> {
  await pool.query("TRUNCATE iris_wakeup");
  return new PostgresScheduler(pool);
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
console.log(`\nstore-postgres smoke: ${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
