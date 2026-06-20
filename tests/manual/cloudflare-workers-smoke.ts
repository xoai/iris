// MANUAL smoke — NOT in the unit suite, NOT typechecked (tests/manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_EDGE_SMOKE=1 node tests/manual/cloudflare-workers-smoke.ts
//
// The REAL target is Cloudflare Workers + Durable Objects (an edge V8 isolate: no
// held process, remote-only tools, durable state in the DO's transactional storage,
// wakeups via DO alarms). That runtime is FUTURE / environment-dependent — it needs
// `miniflare` (the local workerd) installed AND the @irisrun/core + @irisrun/store-do ESM
// bundled into the Worker (core is node:-free by the C7 boundary guard, so it bundles
// for the isolate unchanged — that is the whole portability claim). The install-free
// suite proves the edge invariant in-process against a fake DurableObjectState
// (tests/store-do*.test.ts + tests/store-do-edge-resume.test.ts).
//
// The PAYOFF this smoke demonstrates: the real `DurableObjectState.storage` already
// satisfies the narrow `DoStorage` interface (get/put/delete/list/transaction/
// setAlarm/getAlarm) that `@irisrun/store-do` was written against — the adapter below is
// near-identity. The DO's single-instance guarantee provides the single-writer lease;
// `setAlarm`/`alarm()` IS `sleepUntil`. So `edgeHost(state.storage)` runs the SAME
// core unchanged on workerd.
import assert from "node:assert/strict";

// Adapt a real Cloudflare `DurableObjectStorage` to the `DoStorage` shape
// (@irisrun/store-do/src/do-storage.ts). Values are Uint8Array (DO storage is
// structured-clone, which carries typed arrays). This is the only "glue" the edge
// target needs — by design.
function doStorageAdapter(storage) {
  const wrap = (s) => ({
    async get(key) {
      return (await s.get(key, { allowConcurrency: false })) ?? undefined;
    },
    async put(key, value) {
      await s.put(key, value);
    },
    async delete(key) {
      return await s.delete(key);
    },
    async list(opts) {
      // DO list() returns a Map<string, value>; honor the optional { prefix }.
      return await s.list(opts?.prefix ? { prefix: opts.prefix } : undefined);
    },
    // The DO single-instance guarantee already serializes access; transaction()
    // makes the compare-and-write atomic (no check→await→mutate gap).
    transaction(fn) {
      return s.transaction((txn) => fn(wrap(txn)));
    },
    async setAlarm(scheduledTime) {
      await s.setAlarm(scheduledTime);
    },
    async getAlarm() {
      return await s.getAlarm();
    },
  });
  return wrap(storage);
}

async function main() {
  if (process.env.IRIS_EDGE_SMOKE !== "1") {
    console.log(
      "skip: set IRIS_EDGE_SMOKE=1 to run the Cloudflare Workers/DO edge smoke (real workerd deploy is future; needs miniflare)",
    );
    return;
  }

  // Refuse LOUDLY if the real edge runtime is absent — never silently fake it.
  let Miniflare;
  try {
    ({ Miniflare } = await import("miniflare"));
  } catch {
    console.error(
      "cloudflare-workers-smoke: `miniflare` is not installed (future edge target). " +
        "Install it (npm i -D miniflare) AND bundle @irisrun/core + @irisrun/store-do into the Worker " +
        "(core is node:-free, so it targets the isolate unchanged). Refusing to fake the edge runtime.",
    );
    process.exit(1);
    return;
  }

  // The Worker module: a Durable Object that adapts state.storage → DoStorage and
  // runs ONE turn per fetch via edgeHost(...). `?start` begins a session that parks
  // on a DO alarm (a timer-wait tactic); the DO `alarm()` handler resumes it on a
  // FRESH isolate invocation — the cold-edge analogue of serverless cold-per-turn.
  // (Bundling note: miniflare must resolve @irisrun/* — configure modulesRoot or a
  // prebuilt bundle. Left to the operator; this is the FUTURE target, like the
  // grpc/ws/otlp smokes.)
  const script = `
    import { edgeHost } from "@irisrun/store-do";
    import { harnessProgram, defaultBundle } from "@irisrun/core";
    // doStorageAdapter is injected via globalThis by the host harness below.
    export class AgentDO {
      constructor(state) { this.state = state; }
      async fetch(req) {
        const storage = globalThis.__doStorageAdapter(this.state.storage);
        const host = edgeHost(storage);
        const bundle = defaultBundle({ safeTools: [] });
        const program = harnessProgram({ messages: [{ role: "user", content: "go" }] }, { invariants: bundle.invariants });
        const performers = {
          tactic: bundle.tacticPerformer,
          model_call: async () => ({ ok: true, value: { role: "assistant", content: "done", stopReason: "end_turn" } }),
        };
        const { runTurnOn } = await import("@irisrun/host");
        const out = await runTurnOn(host, { sessionId: "edge-smoke", defDigest: "img", program, performers, clock: { now: () => Date.now() }, assertReplay: true });
        return new Response(JSON.stringify(out));
      }
      async alarm() { /* dueWakeups → runTurnOn → confirmWoken (resume on the scheduled isolate wake) */ }
    }
    export default {
      async fetch(req, env) {
        const id = env.AGENT.idFromName("edge-smoke");
        return env.AGENT.get(id).fetch(req);
      }
    };
  `;

  const mf = new Miniflare({
    modules: true,
    script,
    durableObjects: { AGENT: "AgentDO" },
    globals: { __doStorageAdapter: doStorageAdapter },
  });
  try {
    const res = await mf.dispatchFetch("http://edge/?start");
    const out = await res.json();
    // The same core, unchanged, on the real workerd-backed isolate.
    assert.ok(
      out.status === "finished" || out.status === "parked",
      `edge turn returned a valid status, got ${JSON.stringify(out)}`,
    );
    console.log(`cloudflare-workers-smoke PASS — edgeHost ran the core on workerd → ${JSON.stringify(out)}`);
  } finally {
    await mf.dispose();
  }
}

main().catch((e) => {
  console.error("cloudflare-workers-smoke FAIL: " + (e && e.message ? e.message : e));
  process.exit(1);
});
