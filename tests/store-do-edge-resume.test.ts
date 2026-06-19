// M6 T4 — the edge done-when #1: "an edge-compatible agent (remote tools, no
// local subprocess) runs on the edge adapter." Three proofs, all install-free
// against FakeDoStorage + a sqlite/fs control:
//
//  (a) PARITY — the SAME image/program/clock on edgeHost(FakeDoStorage) and on a
//      sqlite/fs control finish with canonicalize-equal state+output.
//  (b) COLD-ISOLATE PARK/RESUME ON THE DO ALARM — a decideNext tactic that
//      requests a TIMER wait ({wait:{kind:"timer",at:N}}) parks; the engine routes
//      kind:"timer" to scheduler.sleepUntil, which sets the DO alarm. We assert
//      FakeDoStorage.getAlarm() === at (non-vacuous: the alarm WAS set; an earlier
//      second park LOWERS it). A FRESH DoStateStore+DoScheduler over the same
//      FakeDoStorage (clock advanced past `at`) resumes via dueWakeups→runTurnOn→
//      confirmWoken and finishes — assertReplay green across the cold isolate.
//      (The default bundle would NEVER set the alarm — it parks on a HITL signal
//      routed to waitForSignal; only a timer-wait tactic exercises setAlarm.)
//  (c) CROSS-HOST MIGRATE-TO-EDGE — park on a sqlite/fs source with a LOW
//      snapshotThreshold so a REAL snapshot+truncate occurs (assert
//      readLatestSnapshot non-null — non-vacuous), migrateSession(source → edge),
//      resume on edgeHost, finish with state+output canonicalize-equal to a
//      single-host control.
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
  composeAssemble,
  reactAssembleContext,
} from "@iris/core";
import type {
  EngineDeps,
  HarnessState,
  Json,
  PerformerRegistry,
  Performer,
  ReadonlyHarnessView,
  ModelContext,
} from "@iris/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@iris/store-sqlite";
import { FsStateStore, FsScheduler } from "@iris/store-fs";
import { runTurnOn, type HostAdapter } from "@iris/host";
import { DoStateStore, DoScheduler, edgeHost } from "@iris/store-do";
import { FakeDoStorage } from "./lib/fake-do.ts";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };

// --- (a) PARITY: a remote-tool program (search is safe → no park) -----------

const PARITY_MODEL: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "search", args: { q: "x" } }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
const parityBundle = defaultBundle({ safeTools: ["search"] }); // search safe → runs to finish
const parityProgram = harnessProgram(INPUT, { invariants: parityBundle.invariants });

function parityPerformers(): PerformerRegistry {
  return {
    tactic: parityBundle.tacticPerformer,
    model_call: makeScriptedModel(PARITY_MODEL),
    tool_call: makeFakeTool(() => ({ ok: true, value: { ok: 1 } })),
  };
}

test("T4(a) parity: the SAME image+program on edgeHost(FakeDoStorage) and on a sqlite control finish canonicalize-equal", async () => {
  const edge: HostAdapter = edgeHost(new FakeDoStorage()) as unknown as HostAdapter;
  const control: HostAdapter = {
    name: "vps-sqlite",
    capabilities: { long_running: true, filesystem: true },
    store: new SqliteStateStore(openDatabase(":memory:")),
    scheduler: new SqliteScheduler(openDatabase(":memory:")),
  };

  const re = await runTurnOn(edge, {
    sessionId: "e", defDigest: "img-digest", program: parityProgram,
    performers: parityPerformers(), clock: new TestClock(1), assertReplay: true,
  });
  const rc = await runTurnOn(control, {
    sessionId: "c", defDigest: "img-digest", program: parityProgram,
    performers: parityPerformers(), clock: new TestClock(1), assertReplay: true,
  });

  assert.equal(re.status, "finished");
  assert.equal(rc.status, "finished");
  const oe = re.status === "finished" ? re.output : undefined;
  const oc = rc.status === "finished" ? rc.output : undefined;
  const se = re.status === "finished" ? re.state : undefined;
  const sc = rc.status === "finished" ? rc.state : undefined;
  assert.equal(canonicalize(oe as Json), canonicalize(oc as Json), "edge output must match the control");
  assert.equal(canonicalize(se as Json), canonicalize(sc as Json), "edge state must match the control");
});

// --- (b) COLD-ISOLATE PARK/RESUME ON THE DO ALARM ----------------------------

// A timer-wait decideNext tactic (the harness-decide-wait template): model
// returns end_turn (no tools); decideNext waits ONCE on a timer at `at`, then
// finishes. Routed through the no-tool spine seams. Each runTurnOn instance gets
// a FRESH performer, so the call count survives the cold-isolate resume.
const WAKE_AT = 500;

function timerWaitTactic(): Performer {
  let decideCount = 0;
  return makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "decideNext": {
        const choice: Json = decideCount === 0 ? { wait: { kind: "timer", at: WAKE_AT } } : "finish";
        decideCount += 1;
        return choice;
      }
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });
}

test("T4(b) cold-isolate park/resume ON THE DO ALARM: a timer-wait tactic parks, sets the alarm, and a fresh isolate resumes past it", async () => {
  const storage = new FakeDoStorage();
  const sid = "timer-session";
  // harnessProgram with no invariants config — the no-tool spine runs assemble →
  // await_model → decide_next; the tactic parks on a timer at WAKE_AT.
  const program = harnessProgram(INPUT);

  // Performers persist across the park/resume (a service persists; only state is
  // durable on the storage). The tactic's decideCount + the scripted model index
  // therefore advance correctly: the FIRST live decideNext parks on the timer; the
  // SECOND (after the replay folds the journaled park) finishes. Replay never
  // re-invokes the tactic (the ADR-0007 quarantine), so the cold-isolate resume is
  // deterministic regardless.
  const timerPerformers: PerformerRegistry = {
    tactic: timerWaitTactic(),
    model_call: makeScriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]),
  };

  // 1) PARK on host 1 (a DoStateStore+DoScheduler over the storage).
  const host1: HostAdapter = {
    name: "Cloudflare",
    capabilities: { long_running: false, filesystem: false, local_subprocess: false, websockets: false, tool_locality: "remote" },
    store: new DoStateStore(storage),
    scheduler: new DoScheduler(storage),
  };
  const parked = await runTurnOn(host1, {
    sessionId: sid, defDigest: "edge-img", program, performers: timerPerformers,
    clock: new TestClock(1), assertReplay: true,
  });
  assert.equal(parked.status, "parked", "the timer-wait tactic parks the turn");
  assert.deepEqual(parked.status === "parked" ? parked.wait : null, { kind: "timer", at: WAKE_AT });

  // NON-VACUOUS: the engine routed kind:"timer" to scheduler.sleepUntil → the DO
  // alarm WAS set to the wake time.
  assert.equal(await storage.getAlarm(), WAKE_AT, "the DO alarm is armed at the wake time");

  // the earliest-due invariant: an EARLIER park on a second session LOWERS the alarm
  await host1.scheduler.sleepUntil("other", 100);
  assert.equal(await storage.getAlarm(), 100, "an earlier park lowers the DO alarm");

  // 2) RESUME on a FRESH isolate: new DoStateStore + DoScheduler over the SAME
  //    storage, the alarm clock advanced past WAKE_AT. dueWakeups discovers the
  //    due timer; runTurnOn replays the journal (assertReplay green) and finishes;
  //    confirmWoken consumes the wakeup.
  storage.advanceTo(WAKE_AT);
  const host2: HostAdapter = {
    name: "Cloudflare",
    capabilities: { long_running: false, filesystem: false, local_subprocess: false, websockets: false, tool_locality: "remote" },
    store: new DoStateStore(storage),
    scheduler: new DoScheduler(storage),
  };
  const sched2 = host2.scheduler as unknown as DoScheduler;
  const due = await sched2.dueWakeups(storage.now());
  assert.ok(
    due.some((w) => w.sessionId === sid && w.kind === "timer"),
    "the parked session's timer is due on the fresh isolate",
  );

  const resumed = await runTurnOn(host2, {
    sessionId: sid, defDigest: "edge-img", program, performers: timerPerformers,
    clock: new TestClock(WAKE_AT), assertReplay: true,
  });
  assert.equal(resumed.status, "finished", "the fresh isolate resumes past the alarm and finishes");
  assert.deepEqual(resumed.status === "finished" ? resumed.output : null, {
    reply: { role: "assistant", content: "ok", stopReason: "end_turn" },
  });

  await sched2.confirmWoken(sid, storage.now());
  // consumed: the session's timer no longer re-appears (the "other" park remains)
  const after = await sched2.dueWakeups(storage.now());
  assert.equal(after.some((w) => w.sessionId === sid), false, "confirmWoken consumed the resumed session's timer");
});

// --- (c) CROSS-HOST MIGRATE-TO-EDGE ------------------------------------------
// Park on a sqlite/fs source via the default bundle's HITL gate (ask → signal
// wait), crossing a REAL snapshot boundary (low snapshotThreshold), then
// migrateSession(source.store → edge.store) and resume on edgeHost — finishing
// canonicalize-equal to a single-host control.

const HITL_MODEL: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
const hitlBundle = defaultBundle({ safeTools: [] }); // nothing safe → "rm" → ask → park
const hitlProgram = harnessProgram(INPUT, { invariants: hitlBundle.invariants });

function controlDeps(
  store: EngineDeps<HarnessState>["store"],
  scheduler: EngineDeps<HarnessState>["scheduler"],
  performers: PerformerRegistry,
  defDigest: string,
  snapshotThreshold: number,
  clockStart: number,
): EngineDeps<HarnessState> {
  return {
    store, scheduler, clock: new TestClock(clockStart),
    program: hitlProgram, performers, defDigest, holderId: "H",
    assertReplay: true, snapshotThreshold,
  };
}

// The signal_recv approval is the SAME logical service across the move; it is
// idempotent (a constant {approved:true}), so it survives a re-perform.
function makeApprove(): Performer {
  return async () => ({ ok: true, value: { approved: true } });
}

test("T4(c) cross-host migrate-to-edge: park on fs (real snapshot boundary), migrate fs→edge, resume on edge, canonicalize-equal to a single-host control", async () => {
  const digest = "edge-cross-img";
  const sid = "cross-session";

  // performers persist across the A→B move (only the STORE moves host)
  const abPerformers: PerformerRegistry = {
    tactic: hitlBundle.tacticPerformer,
    model_call: makeScriptedModel(HITL_MODEL),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
    signal_recv: makeApprove(),
  };

  // SOURCE host: serverless-fs (the cross-host control source). LOW
  // snapshotThreshold so the park crosses a REAL snapshot+truncate boundary.
  const root = mkdtempSync(join(tmpdir(), "iris-edge-xhost-"));
  const source: HostAdapter = {
    name: "serverless-fs",
    capabilities: { long_running: false, filesystem: true, tool_locality: "in-process" },
    store: new FsStateStore({ root }),
    scheduler: new FsScheduler({ root }),
  };

  const parked = await runTurnOn(source, {
    sessionId: sid, defDigest: digest, program: hitlProgram, performers: abPerformers,
    clock: new TestClock(1), snapshotThreshold: 2, assertReplay: true,
  });
  assert.equal(parked.status, "parked");
  assert.deepEqual(parked.status === "parked" ? parked.wait : null, { kind: "signal", name: "hitl:a" });

  // NON-VACUOUS: the source snapshotted+truncated before parking (the M-Proof rule)
  const snap = await source.store.readLatestSnapshot(sid);
  assert.ok(snap, "the source must have crossed a snapshot boundary before the park");

  // migrate the session SOURCE → EDGE (store-only; snapshot seeds the edge hwm,
  // then the truncated tail appends densely on the DO store — the R1 path on edge).
  const edge: HostAdapter = edgeHost(new FakeDoStorage()) as unknown as HostAdapter;
  const mig = await migrateSession(source.store, edge.store, sid);
  assert.equal(mig.snapshotUpTo, snap?.upToSeq, "the edge store received the same snapshot boundary");
  // and the edge store really holds the snapshot now (non-vacuous on the edge side too)
  assert.ok(await edge.store.readLatestSnapshot(sid), "the edge store has the migrated snapshot");

  // resume on the EDGE host from the SAME journal (a fresh DoScheduler — resume is
  // signal-driven from the journal, as in M-Proof). assertReplay stays green.
  const resumed = await runTurnOn(edge, {
    sessionId: sid, defDigest: digest, program: hitlProgram, performers: abPerformers,
    clock: new TestClock(1), assertReplay: true,
  });
  assert.equal(resumed.status, "finished");

  // SINGLE-HOST CONTROL: the SAME image digest + scripts run entirely on one fresh
  // sqlite store (its own performers; default threshold → no snapshot).
  const ctlPerformers: PerformerRegistry = {
    tactic: hitlBundle.tacticPerformer,
    model_call: makeScriptedModel(HITL_MODEL),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
    signal_recv: makeApprove(),
  };
  const ctlStore = new SqliteStateStore(openDatabase(":memory:"));
  const ctlSched = new SqliteScheduler(openDatabase(":memory:"));
  const cPark = await runTurn(controlDeps(ctlStore, ctlSched, ctlPerformers, digest, 64, 1), "ctl");
  assert.equal(cPark.status, "parked");
  const cDone = await runTurn(controlDeps(ctlStore, ctlSched, ctlPerformers, digest, 64, 1), "ctl");
  assert.equal(cDone.status, "finished");

  // ASSERT: the edge-resumed state + output are byte-identical to the control.
  const eState = resumed.status === "finished" ? resumed.state : undefined;
  const eOutput = resumed.status === "finished" ? resumed.output : undefined;
  const cState = cDone.status === "finished" ? cDone.state : undefined;
  const cOutput = cDone.status === "finished" ? cDone.output : undefined;
  assert.equal(
    canonicalize(eOutput as Json),
    canonicalize(cOutput as Json),
    "edge-resumed output must byte-equal the single-host control output",
  );
  assert.equal(
    canonicalize(eState as Json),
    canonicalize(cState as Json),
    "edge-resumed state must byte-equal the single-host control state",
  );
});
