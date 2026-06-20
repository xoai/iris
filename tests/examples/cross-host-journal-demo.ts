// The one-command, install-free, DETERMINISTIC
// cross-host resume demo. The SAME governed agent session migrates
// laptop(fs) → VPS(sqlite) → edge(Durable Objects code path) as a portable,
// content-addressed *.irisjournal file, resumes byte-identically on the edge,
// and self-verifies at every hop. Final state is byte-identical to a single-host
// control. Run it: `npm run demo:cross-host`.
//
// Fully typed (it is typechecked via tests/journal-cross-host-demo.test.ts, which
// imports runCrossHostDemo — tsc follows imports past tsconfig's exclude).
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import type { Json, PerformerRegistry, HarnessState, Reducer } from "@irisrun/core";
import { runTurnOn, type HostAdapter } from "@irisrun/host";
import { SqliteStateStore, SqliteScheduler, openDatabase } from "@irisrun/store-sqlite";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { edgeHost } from "@irisrun/store-do";
import { exportSession, importSession, encodeExport, decodeExport, verifyExport } from "@irisrun/journal-export";
import { verifySession } from "@irisrun/audit";
import { TestClock } from "../lib/mem-store.ts";
import { makeScriptedModel } from "../lib/fake-model.ts";
import { makeFakeTool } from "../lib/fake-tool.ts";
import { makeFakeSignal } from "../lib/fake-signal.ts";
import { FakeDoStorage } from "../lib/fake-do.ts";

const DEF = "sha256:demo-cross-host";
const INPUT = { messages: [{ role: "user", content: "go" }] };
// One gated tool call (parks at HITL), then done — the natural mid-task pause we
// migrate across hosts.
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

export interface DemoHop {
  host: string;
  contentDigest: string;
  finalStateDigest: string | null;
  complete: boolean;
  verifyOk: boolean;
}
export interface DemoReport {
  hops: DemoHop[];
  controlFinalDigest: string | null;
  finishedFinalDigest: string | null;
  identical: boolean;
}

export async function runCrossHostDemo(): Promise<DemoReport> {
  const bundle = defaultBundle({ safeTools: [] }); // nothing safe → "rm" → ask → park
  const program = harnessProgram(INPUT, { invariants: bundle.invariants });
  const reducer: Reducer<HarnessState> = program.reducer;

  // ONE shared scripted model across the hosts that actually run a turn (A, then C).
  // Replay never re-invokes it, so its call-index sequencing stays correct across the
  // migration: host A advances it to "done", host C resumes there.
  const sharedPerformers: PerformerRegistry = {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
    signal_recv: makeFakeSignal(true),
  };

  const SID = "cross-host-demo";
  const hops: DemoHop[] = [];

  const verifyHop = (host: string, bytes: Uint8Array): DemoHop => {
    const x = decodeExport(bytes);
    const opts: { reducer: Reducer<HarnessState>; startState?: HarnessState } = { reducer };
    if (!x.snapshot) opts.startState = program.initial; // no-snapshot window starts from the harness initial
    const r = verifyExport(bytes, opts);
    const hop: DemoHop = {
      host,
      contentDigest: r.contentAddress.actualDigest,
      finalStateDigest: r.finalStateDigest ?? null,
      complete: r.structural.complete,
      verifyOk: r.ok,
    };
    hops.push(hop);
    return hop;
  };

  // ── Host A — "laptop" (filesystem). Start; park at HITL across a snapshot+truncate boundary.
  const fsRoot = mkdtempSync(join(tmpdir(), "iris-demo-laptop-"));
  const hostA: HostAdapter = {
    name: "laptop-fs",
    capabilities: { long_running: true, filesystem: true },
    store: new FsStateStore({ root: fsRoot }),
    scheduler: new FsScheduler({ root: fsRoot }),
  };
  const a = await runTurnOn(hostA, {
    sessionId: SID, defDigest: DEF, program, performers: sharedPerformers,
    clock: new TestClock(1), snapshotThreshold: 2, assertReplay: true,
  });
  if (a.status !== "parked") throw new Error(`demo: host A expected 'parked', got '${a.status}'`);
  const fileA = encodeExport(await exportSession(hostA.store, SID));
  verifyHop("laptop-fs (parked)", fileA);

  // ── Host B — "VPS" (sqlite). Transit: import the file, re-export, verify (no resume).
  const hostBStore = new SqliteStateStore(openDatabase(":memory:"));
  await importSession(hostBStore, decodeExport(fileA));
  const fileB = encodeExport(await exportSession(hostBStore, SID));
  verifyHop("vps-sqlite (transit)", fileB);

  // ── Host C — "edge" (Durable Objects code path). Import; resume to finish.
  const edge = edgeHost(new FakeDoStorage(), "edge-do");
  await importSession(edge.store, decodeExport(fileB));
  const c = await runTurnOn(edge as unknown as HostAdapter, {
    sessionId: SID, defDigest: DEF, program, performers: sharedPerformers,
    clock: new TestClock(1), assertReplay: true,
  });
  if (c.status !== "finished") throw new Error(`demo: host C expected 'finished', got '${c.status}'`);
  const fileC = encodeExport(await exportSession(edge.store, SID));
  const hopC = verifyHop("edge-do (finished)", fileC);

  // ── Control — the SAME image+script start-to-finish on ONE fresh store.
  const ctlStore = new SqliteStateStore(openDatabase(":memory:"));
  const ctlHost: HostAdapter = {
    name: "control",
    capabilities: { long_running: true, filesystem: true },
    store: ctlStore,
    scheduler: new SqliteScheduler(openDatabase(":memory:")),
  };
  const ctlPerformers: PerformerRegistry = {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
    signal_recv: makeFakeSignal(true),
  };
  const p1 = await runTurnOn(ctlHost, {
    sessionId: "ctl", defDigest: DEF, program, performers: ctlPerformers,
    clock: new TestClock(1), snapshotThreshold: 64, assertReplay: true,
  });
  if (p1.status !== "parked") throw new Error(`demo: control turn 1 expected 'parked', got '${p1.status}'`);
  const p2 = await runTurnOn(ctlHost, {
    sessionId: "ctl", defDigest: DEF, program, performers: ctlPerformers,
    clock: new TestClock(1), assertReplay: true,
  });
  if (p2.status !== "finished") throw new Error(`demo: control expected 'finished', got '${p2.status}'`);
  const control = await verifySession(ctlStore, "ctl", reducer, { startState: program.initial });

  const identical = hopC.finalStateDigest !== null && hopC.finalStateDigest === control.finalStateDigest;
  return {
    hops,
    controlFinalDigest: control.finalStateDigest,
    finishedFinalDigest: hopC.finalStateDigest,
    identical,
  };
}

async function main(): Promise<void> {
  const r = await runCrossHostDemo();
  console.log("Iris — cross-host resume + verifiable journal demo\n");
  console.log("A governed agent session migrates laptop → VPS → edge as a portable,");
  console.log("content-addressed *.irisjournal file, resuming byte-identically on the edge.\n");
  for (const h of r.hops) {
    console.log(
      `  ${h.host.padEnd(22)}  contentDigest ${h.contentDigest.slice(0, 16)}…  ` +
        `finalState ${h.finalStateDigest ?? "—"}  complete=${h.complete}  verify=${h.verifyOk ? "OK ✅" : "FAIL ❌"}`,
    );
  }
  console.log(`\n  single-host control  finalState ${r.controlFinalDigest}`);
  console.log(
    r.identical
      ? "\n✅ The edge-resumed session's final state is BYTE-IDENTICAL to the single-host control."
      : "\n❌ MISMATCH — cross-host final state differs from the control.",
  );
  const allVerified = r.hops.every((h) => h.verifyOk);
  if (!r.identical || !allVerified) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
