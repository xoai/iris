// T5 — HostAdapter parity + the tool/host-level capability check.
// runTurnOn runs the SAME image+program on host A (sqlite, long-running) and host
// B (serverless-fs) with EQUIVALENT results — the engine's deterministic replay
// makes "same image, different host" hold. checkHostCapabilities REFUSES LOUDLY
// when the image requires a capability the host does not provide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessProgram, defaultBundle, canonicalize } from "@irisrun/core";
import type { PerformerRegistry, Json } from "@irisrun/core";
import { openDatabase, SqliteStateStore, SqliteScheduler } from "@irisrun/store-sqlite";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { runTurnOn, checkHostCapabilities, type HostAdapter } from "@irisrun/host";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const MODEL: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "search", args: { q: "x" } }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

const bundle = defaultBundle({ safeTools: ["search"] }); // search is safe → no park, runs to finish
const program = harnessProgram(INPUT, { invariants: bundle.invariants });

// Fresh performers per host: each host runs ONE complete turn, so the scripted
// model's call sequence is identical and independent.
function performers(): PerformerRegistry {
  return {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(MODEL),
    tool_call: makeFakeTool(() => ({ ok: true, value: { ok: 1 } })),
  };
}

test("T5 parity: the same image+program on host A (sqlite) and host B (fs) finish with equivalent state+output", async () => {
  const hostA: HostAdapter = {
    name: "vps-sqlite",
    capabilities: { long_running: true, filesystem: true },
    store: new SqliteStateStore(openDatabase(":memory:")),
    scheduler: new SqliteScheduler(openDatabase(":memory:")),
  };
  const root = mkdtempSync(join(tmpdir(), "iris-host-"));
  const hostB: HostAdapter = {
    name: "serverless-fs",
    capabilities: { long_running: false, filesystem: true, tool_locality: "in-process" },
    store: new FsStateStore({ root }),
    scheduler: new FsScheduler({ root }),
  };

  const ra = await runTurnOn(hostA, {
    sessionId: "a", defDigest: "img-digest", program, performers: performers(), clock: new TestClock(1),
  });
  const rb = await runTurnOn(hostB, {
    sessionId: "b", defDigest: "img-digest", program, performers: performers(), clock: new TestClock(1),
  });

  assert.equal(ra.status, "finished");
  assert.equal(rb.status, "finished");
  const outA = ra.status === "finished" ? ra.output : undefined;
  const outB = rb.status === "finished" ? rb.output : undefined;
  const stA = ra.status === "finished" ? ra.state : undefined;
  const stB = rb.status === "finished" ? rb.state : undefined;
  assert.equal(canonicalize(outA as Json), canonicalize(outB as Json), "output must match across hosts");
  assert.equal(canonicalize(stA as Json), canonicalize(stB as Json), "final state must match across hosts");
});

test("T5 capability check: refuses LOUDLY when the host lacks a required capability (false or undefined)", async () => {
  const longRunningHost = { long_running: true, filesystem: true };
  const serverlessHost = { long_running: false, filesystem: true, tool_locality: "in-process" as const };

  // image requires long_running; the serverless host says false → refuse
  assert.throws(
    () => checkHostCapabilities({ long_running: true }, serverlessHost, "serverless-fs"),
    /cannot satisfy required capabilities.*long_running/s,
  );
  // host that simply OMITS the cap (undefined) is also unsatisfied — not silently widened
  assert.throws(
    () => checkHostCapabilities({ long_running: true }, { filesystem: true }, "minimal"),
    /long_running/,
  );
  // a long-running host satisfies it
  assert.doesNotThrow(() => checkHostCapabilities({ long_running: true }, longRunningHost, "vps"));
  // a capability the image does NOT require is never gated
  assert.doesNotThrow(() => checkHostCapabilities({ filesystem: true }, serverlessHost, "serverless-fs"));
});
