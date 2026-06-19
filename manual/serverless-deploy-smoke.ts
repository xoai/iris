// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_SERVERLESS_SMOKE=1 node manual/serverless-deploy-smoke.ts
//
// The REAL target is a serverless host (Cloudflare Durable Objects / AWS Lambda):
// no held process, a cold invocation per turn, durable state in the platform's
// store. That deploy is FUTURE (needs cloud creds) — the install-free suite proves
// the invariant in-process (tests/store-fs-serverless.test.ts + cross-host-resume).
//
// When enabled, this smoke runs the closest REAL thing available without a cloud
// account: a cross-host resume over a PERSISTENT on-disk fs root, driving every
// turn with a FRESH FsStateStore instance (a true cold start — no shared handle),
// to prove a serverless-style host rehydrates purely from disk.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSession, harnessProgram, defaultBundle } from "@iris/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@iris/store-sqlite";
import { FsStateStore, FsScheduler } from "@iris/store-fs";
import { runTurnOn } from "@iris/host";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function scriptedModel(responses) {
  let i = 0;
  return async () => { const value = responses[Math.min(i, responses.length - 1)]; i += 1; return { ok: true, value }; };
}

async function main() {
  if (process.env.IRIS_SERVERLESS_SMOKE !== "1") {
    console.log("skip: set IRIS_SERVERLESS_SMOKE=1 to run the serverless cold-restart smoke (real CF/Lambda deploy is future)");
    return;
  }
  const bundle = defaultBundle({ safeTools: [] });
  const program = harnessProgram(INPUT, { invariants: bundle.invariants });
  const log = [];
  const performers = {
    tactic: bundle.tacticPerformer,
    model_call: scriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: async (r) => { log.push(r); return { ok: true, value: { done: 1 } }; },
    signal_recv: async () => ({ ok: true, value: { approved: true } }),
  };
  const sid = "serverless-smoke";

  // host A: a long-running sqlite host parks the session
  const hostA = { name: "vps-sqlite", capabilities: { long_running: true, filesystem: true }, store: new SqliteStateStore(openDatabase(":memory:")), scheduler: new SqliteScheduler(openDatabase(":memory:")) };
  const root = mkdtempSync(join(tmpdir(), "iris-serverless-smoke-"));
  try {
    const parked = await runTurnOn(hostA, { sessionId: sid, defDigest: "img", program, performers, clock: { now: () => 1 }, snapshotThreshold: 2, assertReplay: true });
    assert.equal(parked.status, "parked", "host A should park on HITL");

    // migrate to a PERSISTENT on-disk fs root (the serverless store)
    await migrateSession(hostA.store, new FsStateStore({ root }), sid);

    // resume with a FRESH FsStateStore + FsScheduler — a cold serverless invocation
    const coldHostB = { name: "serverless-fs", capabilities: { long_running: false, filesystem: true }, store: new FsStateStore({ root }), scheduler: new FsScheduler({ root }) };
    const resumed = await runTurnOn(coldHostB, { sessionId: sid, defDigest: "img", program, performers, clock: { now: () => 1 }, assertReplay: true });
    assert.equal(resumed.status, "finished", "a cold fs instance must resume + finish");
    assert.equal(log.length, 1, "the approved tool ran exactly once on the cold host");
    console.log(`serverless-smoke PASS — cold fs instance over ${root} resumed from disk → finished ${JSON.stringify(resumed.output)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("serverless-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
