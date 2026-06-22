// Env-gated live-MongoDB certification for @irisrun/store-mongo. Runs the SAME
// @irisrun/store-conformance cases the built-in stores pass, against a REAL MongoDB — so a
// green run = a certified store. Outside `npm test` (tests/smoke/** is excluded from the
// suite + typecheck), like the postgres/mysql smokes, because it needs a live database and
// the `mongodb` peer dependency installed. NO replica set is required — the store uses no
// multi-document transaction.
//
//   IRIS_MONGO_SMOKE=1 IRIS_MONGO_URL=mongodb://host:27017/agents \
//     node --conditions=iris-src tests/smoke/store-mongo-smoke.ts
import { runStoreConformance, runSchedulerConformance } from "@irisrun/store-conformance";
import { MongoStateStore, MongoScheduler, connect } from "@irisrun/store-mongo";

const url = process.env.IRIS_MONGO_URL;
if (process.env.IRIS_MONGO_SMOKE !== "1" || !url) {
  console.log("store-mongo smoke: set IRIS_MONGO_SMOKE=1 and IRIS_MONGO_URL=mongodb://… (and `npm i mongodb`) to run.");
  process.exit(0);
}

const { db, close } = await connect(url);
const COLLECTIONS = ["iris_kv", "iris_meta", "iris_journal", "iris_snapshot", "iris_wakeup"];

// Each conformance case wants a CLEAN store; MongoDB is a shared DB, so drop the iris_*
// collections (deleteMany with an empty filter) between cases.
async function clear(): Promise<void> {
  for (const name of COLLECTIONS) await db.collection(name).deleteMany({});
}
async function freshStore(): Promise<MongoStateStore> {
  await clear();
  return new MongoStateStore(db);
}
async function freshScheduler(): Promise<MongoScheduler> {
  await clear();
  return new MongoScheduler(db);
}

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
await close();
console.log(`\nstore-mongo smoke: ${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
