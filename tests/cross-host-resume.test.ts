// T3 (M-Proof) — THE DoD: cross-host resume. The SAME M4 agent image starts a
// session on host A (sqlite, long-running), parks at a turn boundary via HITL, and
// RESUMES on host B (serverless-fs) from the SAME journal — a deterministic replay
// with identical output. This is ASSEMBLY of shipped parts: migrateSession (A→B,
// store-only), acquireLease, the always-on replay assertion, and the M4 image.
// ZERO engine change.
//
// Extends tests/cross-store.test.ts (the control + canonicalize-equality pattern)
// and the harness-hitl pattern (park via default-bundle gateAction:"ask" → signal
// wait; resume via the signal_recv approval performer). The host-A park crosses a
// REAL snapshot+truncate boundary (low snapshotThreshold) so the migration is
// non-vacuous — it exercises snapshot-seeds-hwm + the truncated tail on fs (R1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTurn,
  migrateSession,
  canonicalize,
  harnessProgram,
  defaultBundle,
} from "@irisrun/core";
import type { EngineDeps, HarnessState, Json, PerformerRegistry } from "@irisrun/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { runTurnOn, type HostAdapter } from "@irisrun/host";
import { buildImage, makeLocalResolver, parseAgentfileJson, governingDigest } from "@irisrun/agent";
import type { ToolContract } from "@irisrun/tools";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
// The default M4 bundle gates the irreversible "rm" tool to ASK → the kernel parks
// on the hitl:<callId> signal; the resume approves it and the loop finishes.
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

const bundle = defaultBundle({ safeTools: [] }); // nothing is safe → "rm" → ask → park
const program = harnessProgram(INPUT, { invariants: bundle.invariants });

// Build a REAL M4 image and use its imageDigest as the governing defDigest on BOTH
// hosts and the control — that is what makes it "the same image" (no checked-in
// digest constant). The image's tool list is irrelevant to the runtime gate above;
// it is used here only for its content-addressed digest (ADR-0002/0004 pin).
async function buildDemoImageDigest(): Promise<string> {
  const rm: ToolContract = {
    name: "rm", description: "remove", inputSchema: { type: "object" },
    transport: "mcp", location: "mcp://registry/rm", retrySafe: false,
  };
  const resolver = makeLocalResolver({ "mcp://registry/rm": rm });
  const model = parseAgentfileJson(JSON.stringify({
    apiVersion: "iris/v1", kind: "Agent", name: "portability-demo", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [],
    tools: [{ ref: "mcp://registry/rm" }], connections: [],
    harness: { bundle: "default" },
    requires: { long_running: true, tool_locality: "local" },
    sandbox: { backend: "inmemory", network: "deny-all" },
  }));
  const readFile = (p: string): Promise<Uint8Array> =>
    p === "./instructions.md"
      ? Promise.resolve(new TextEncoder().encode("You are the portability demo."))
      : Promise.reject(new Error(`no file: ${p}`));
  const img = await buildImage(model, { resolver, readFile });
  return img.lock.imageDigest;
}

function controlDeps(
  store: EngineDeps<HarnessState>["store"],
  scheduler: EngineDeps<HarnessState>["scheduler"],
  performers: PerformerRegistry,
  defDigest: string,
  snapshotThreshold: number,
): EngineDeps<HarnessState> {
  return {
    store, scheduler, clock: new TestClock(1),
    program, performers, defDigest, holderId: "H",
    assertReplay: true, snapshotThreshold,
  };
}

test("T3 DoD: same M4 image — start+park on host A (sqlite), migrate A→B, resume on host B (fs); replay + output identical to a single-host control; pin held", async () => {
  const digest = await buildDemoImageDigest();
  assert.match(digest, /^[0-9a-f]{64}$/, "a real, content-addressed image digest");

  // === The A→B move. Performers persist across the move (the model/tool/HITL
  // service is the SAME logical service; only the STORE moves host). ===
  const abLog: ToolCallLog = { calls: [] };
  const abPerformers: PerformerRegistry = {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } }), abLog),
    signal_recv: makeFakeSignal(true),
  };

  const hostA: HostAdapter = {
    name: "vps-sqlite",
    capabilities: { long_running: true, filesystem: true },
    store: new SqliteStateStore(openDatabase(":memory:")),
    scheduler: new SqliteScheduler(openDatabase(":memory:")),
  };
  const root = mkdtempSync(join(tmpdir(), "iris-xhost-"));
  const hostB: HostAdapter = {
    name: "serverless-fs",
    capabilities: { long_running: false, filesystem: true, tool_locality: "in-process" },
    store: new FsStateStore({ root }),
    scheduler: new FsScheduler({ root }),
  };

  const sid = "demo-session";

  // 1) start on host A with a LOW snapshotThreshold → the park CROSSES a real
  //    snapshot+truncate boundary (non-vacuous migration). assertReplay is on.
  const parked = await runTurnOn(hostA, {
    sessionId: sid, defDigest: digest, program, performers: abPerformers,
    clock: new TestClock(1), snapshotThreshold: 2, assertReplay: true,
  });
  assert.equal(parked.status, "parked");
  assert.deepEqual(parked.status === "parked" ? parked.wait : null, { kind: "signal", name: "hitl:a" });
  assert.equal(abLog.calls.length, 0, "the gated tool has not run yet");

  // the migration is NON-VACUOUS: host A snapshotted+truncated before parking
  const snap = await hostA.store.readLatestSnapshot(sid);
  assert.ok(snap, "host A must have crossed a snapshot boundary before the park");

  // 2) migrate the session A → B (store-only copy; snapshot seeds B's hwm, then
  //    the truncated tail appends densely on the fs store — the R1 path).
  const mig = await migrateSession(hostA.store, hostB.store, sid);
  assert.equal(mig.snapshotUpTo, snap?.upToSeq, "B received the same snapshot boundary");

  // 3) resume on host B from the SAME journal — read the approval, run the tool,
  //    finish. assertReplay stays green across the host move.
  const resumed = await runTurnOn(hostB, {
    sessionId: sid, defDigest: digest, program, performers: abPerformers,
    clock: new TestClock(1), assertReplay: true,
  });
  assert.equal(resumed.status, "finished");
  assert.equal(abLog.calls.length, 1, "the approved tool runs exactly once on host B");

  // === The single-host CONTROL: the SAME image digest + scripts run entirely on
  // one fresh sqlite store (its own performers; default threshold → no snapshot). ===
  const ctlLog: ToolCallLog = { calls: [] };
  const ctlPerformers: PerformerRegistry = {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } }), ctlLog),
    signal_recv: makeFakeSignal(true),
  };
  const ctlStore = new SqliteStateStore(openDatabase(":memory:"));
  const ctlSched = new SqliteScheduler(openDatabase(":memory:"));
  const cPark = await runTurn(controlDeps(ctlStore, ctlSched, ctlPerformers, digest, 64), "ctl");
  assert.equal(cPark.status, "parked");
  const cDone = await runTurn(controlDeps(ctlStore, ctlSched, ctlPerformers, digest, 64), "ctl");
  assert.equal(cDone.status, "finished");

  // === ASSERT THE DoD: host-B state + output are byte-identical to the control. ===
  const bState = resumed.status === "finished" ? resumed.state : undefined;
  const bOutput = resumed.status === "finished" ? resumed.output : undefined;
  const cState = cDone.status === "finished" ? cDone.state : undefined;
  const cOutput = cDone.status === "finished" ? cDone.output : undefined;
  assert.equal(
    canonicalize(bOutput as Json),
    canonicalize(cOutput as Json),
    "cross-host output must byte-equal the single-host control output",
  );
  assert.equal(
    canonicalize(bState as Json),
    canonicalize(cState as Json),
    "cross-host resumed state must byte-equal the single-host control state",
  );

  // the pin held across the move (ADR-0002/0004): the governing digest is unchanged
  assert.equal(await governingDigest(hostB.store, sid), digest, "host B is pinned to the same image");
  assert.equal(await governingDigest(ctlStore, "ctl"), digest, "the control is pinned to the same image");
});
