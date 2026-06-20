// MANUAL demo — the README portability proof. Unlike the docker/registry smokes
// this runs INSTALL-FREE (node:sqlite + node:fs + workspace packages), so it needs
// no env gate:
//   node tests/manual/portability-demo.ts
// It is NOT in the unit suite and NOT typechecked (tests/manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob); the same proof is
// regression-locked by tests/cross-host-resume.test.ts.
//
// What it shows: the SAME M4 agent image starts a session on host A (sqlite,
// long-running), parks at a turn boundary via HITL, and RESUMES on host B
// (serverless-fs) from the SAME journal — a deterministic replay with output
// identical to a single-host control. ZERO engine change; the move is just
// migrateSession + the always-on replay assertion + the M4 image pin.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTurn, migrateSession, canonicalize, harnessProgram, defaultBundle,
} from "@irisrun/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { runTurnOn } from "@irisrun/host";
import { buildImage, makeLocalResolver, parseAgentfileJson, governingDigest } from "@irisrun/agent";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

// tiny inline performers (self-contained; mirrors tests/lib fixtures)
function scriptedModel(responses) {
  let i = 0;
  return async () => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, value };
  };
}
function fakeTool(log) {
  return async (request) => { log.push(request); return { ok: true, value: { done: 1 } }; };
}
function approve() {
  return async () => ({ ok: true, value: { approved: true } });
}

async function imageDigest() {
  const rm = { name: "rm", description: "remove", inputSchema: { type: "object" }, transport: "mcp", location: "mcp://registry/rm", retrySafe: false };
  const resolver = makeLocalResolver({ "mcp://registry/rm": rm });
  const model = parseAgentfileJson(JSON.stringify({
    apiVersion: "iris/v1", kind: "Agent", name: "portability-demo", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [], tools: [{ ref: "mcp://registry/rm" }], connections: [],
    harness: { bundle: "default" }, requires: { long_running: true, tool_locality: "local" },
    sandbox: { backend: "inmemory", network: "deny-all" },
  }));
  const readFile = (p) => p === "./instructions.md"
    ? Promise.resolve(new TextEncoder().encode("You are the portability demo."))
    : Promise.reject(new Error(`no file: ${p}`));
  const img = await buildImage(model, { resolver, readFile });
  return img.lock.imageDigest;
}

async function main() {
  const bundle = defaultBundle({ safeTools: [] });
  const program = harnessProgram(INPUT, { invariants: bundle.invariants });
  const digest = await imageDigest();
  console.log(`\n  Iris portability proof — cross-host resume`);
  console.log(`  image digest (the pin): ${digest.slice(0, 16)}…\n`);

  // performers persist across the move (same logical model/tool/HITL service)
  const log = [];
  const performers = { tactic: bundle.tacticPerformer, model_call: scriptedModel(ONE_TOOL_THEN_DONE), tool_call: fakeTool(log), signal_recv: approve() };

  const hostA = { name: "vps-sqlite", capabilities: { long_running: true, filesystem: true }, store: new SqliteStateStore(openDatabase(":memory:")), scheduler: new SqliteScheduler(openDatabase(":memory:")) };
  const root = mkdtempSync(join(tmpdir(), "iris-portability-demo-"));
  const hostB = { name: "serverless-fs", capabilities: { long_running: false, filesystem: true, tool_locality: "in-process" }, store: new FsStateStore({ root }), scheduler: new FsScheduler({ root }) };
  const sid = "demo-session";

  const parked = await runTurnOn(hostA, { sessionId: sid, defDigest: digest, program, performers, clock: { now: () => 1 }, snapshotThreshold: 2, assertReplay: true });
  assert.equal(parked.status, "parked");
  console.log(`  ① host A (${hostA.name}): turn ran → parked on HITL ${JSON.stringify(parked.wait)} (replay assertion green)`);

  const snap = await hostA.store.readLatestSnapshot(sid);
  assert.ok(snap, "host A should have snapshotted before parking");
  console.log(`  ② host A crossed a real snapshot+truncate boundary (snapshot @ seq ${snap.upToSeq}) — the migration is non-vacuous`);

  const mig = await migrateSession(hostA.store, hostB.store, sid);
  console.log(`  ③ migrateSession A→B: copied snapshot @ ${mig.snapshotUpTo} + ${mig.records} journal record(s) to ${hostB.name} (store-only, port-only)`);

  const resumed = await runTurnOn(hostB, { sessionId: sid, defDigest: digest, program, performers, clock: { now: () => 1 }, assertReplay: true });
  assert.equal(resumed.status, "finished");
  assert.equal(log.length, 1, "the approved tool runs exactly once on host B");
  console.log(`  ④ host B (${hostB.name}): resumed from the SAME journal → finished (replay assertion green); output ${JSON.stringify(resumed.output)}`);

  // single-host control (same image + scripts on one fresh sqlite store)
  const ctlLog = [];
  const ctlPerformers = { tactic: bundle.tacticPerformer, model_call: scriptedModel(ONE_TOOL_THEN_DONE), tool_call: fakeTool(ctlLog), signal_recv: approve() };
  const ctlStore = new SqliteStateStore(openDatabase(":memory:"));
  const ctlSched = new SqliteScheduler(openDatabase(":memory:"));
  const ctlDeps = (t) => ({ store: ctlStore, scheduler: ctlSched, clock: { now: () => 1 }, program, performers: ctlPerformers, defDigest: digest, holderId: "H", assertReplay: true, snapshotThreshold: 64 });
  await runTurn(ctlDeps(), "ctl");
  const ctlDone = await runTurn(ctlDeps(), "ctl");
  assert.equal(ctlDone.status, "finished");

  assert.equal(canonicalize(resumed.output), canonicalize(ctlDone.output), "output must match the control");
  assert.equal(canonicalize(resumed.state), canonicalize(ctlDone.state), "state must match the control");
  assert.equal(await governingDigest(hostB.store, sid), digest, "pin held on host B");
  console.log(`  ⑤ DoD: host-B state + output are BYTE-IDENTICAL to the single-host control, and the image pin is unchanged.\n`);
  console.log(`  ✓ PASS — the same session ran across two different hosts with a deterministic, identical result.\n`);
}

main().catch((e) => { console.error(`\n  ✗ portability-demo FAILED: ${e && e.message ? e.message : e}\n`); process.exit(1); });
