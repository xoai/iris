// Env-gated live-Redis certification for @irisrun/store-redis. Runs the SAME
// @irisrun/store-conformance cases the built-in stores pass, against a REAL Redis — so a
// green run = a certified store. Outside `npm test` (tests/smoke/** is excluded from the
// suite + typecheck), like the docker / registry / postgres / mysql smokes, because it
// needs a live server and the `redis` peer dependency installed.
//
//   IRIS_REDIS_SMOKE=1 IRIS_REDIS_URL=redis://host:6379 \
//     node --conditions=iris-src tests/smoke/store-redis-smoke.ts
import { runStoreConformance, runSchedulerConformance } from "@irisrun/store-conformance";
import { RedisStateStore, RedisScheduler, createClient } from "@irisrun/store-redis";

const url = process.env.IRIS_REDIS_URL;
if (process.env.IRIS_REDIS_SMOKE !== "1" || !url) {
  console.log("store-redis smoke: set IRIS_REDIS_SMOKE=1 and IRIS_REDIS_URL=redis://… (and `npm i redis`) to run.");
  process.exit(0);
}

const redis = await createClient(url);

// Each conformance case wants a CLEAN store; Redis is a shared server, so delete the
// iris:* keys the suite touches between cases. (We avoid FLUSHDB so an operator can point
// at a shared DB safely — only this adapter's namespace is cleared.) The conformance suite
// uses a small, fixed set of keys ("lease:s", "k", sessions "s"/"s1"/"s2"), so an explicit
// del list through the narrow RedisLike surface suffices — no raw-client scan needed.
async function clearNamespace(): Promise<void> {
  const keys = [
    "iris:kv:lease:s",
    "iris:kv:k",
    "iris:meta:s",
    "iris:meta:s1",
    "iris:meta:s2",
    "iris:journal:s",
    "iris:journal:s1",
    "iris:journal:s2",
    "iris:snap:s",
    "iris:snap:s1",
    "iris:snap:s2",
    "iris:wakeups",
    "iris:wakeup:id",
  ];
  await redis.del(keys);
}

async function freshStore(): Promise<RedisStateStore> {
  await clearNamespace();
  return new RedisStateStore(redis);
}
async function freshScheduler(): Promise<RedisScheduler> {
  await clearNamespace();
  return new RedisScheduler(redis);
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
await redis.close();
console.log(`\nstore-redis smoke: ${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
