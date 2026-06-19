// MANUAL smoke — NOT in the unit suite, NOT typechecked (repo-root manual/).
//   IRIS_OTLP_SMOKE=1 node manual/otlp-export-smoke.ts
//
// The install-free core (@iris/observe.toSpans) derives OTel-shaped spans from a
// recorded session; exporting them to a REAL backend over OTLP needs
// @opentelemetry/* (future). When enabled, this records a session, builds the spans
// (install-free), then attempts a real OTLP export — refusing LOUDLY with install
// guidance if the OTel SDK is absent.
import assert from "node:assert/strict";
import { runTurn, harnessProgram, defaultBundle } from "@iris/core";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { inspectSession } from "@iris/inspect";
import { toSpans } from "@iris/observe";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
function scriptedModel(responses) { let i = 0; return async () => { const value = responses[Math.min(i, responses.length - 1)]; i += 1; return { ok: true, value }; }; }

async function main() {
  if (process.env.IRIS_OTLP_SMOKE !== "1") {
    console.log("skip: set IRIS_OTLP_SMOKE=1 to run the OTLP export smoke (future — needs @opentelemetry/*)");
    return;
  }
  // record a finished session (install-free)
  const store = new MemoryStateStore();
  const bundle = defaultBundle({ safeTools: [] });
  const performers = { tactic: bundle.tacticPerformer, model_call: scriptedModel(ONE_TOOL_THEN_DONE), tool_call: async () => ({ ok: true, value: { done: 1 } }), signal_recv: async () => ({ ok: true, value: { approved: true } }) };
  const deps = () => ({ store, scheduler: new MemoryScheduler(), clock: { now: () => 1 }, program: harnessProgram(INPUT, { invariants: bundle.invariants }), performers, defDigest: "d", holderId: "H", assertReplay: true });
  await runTurn(deps(), "s");
  await runTurn(deps(), "s");

  const spans = toSpans(await inspectSession(store, "s"));
  assert.ok(spans.length > 0, "toSpans produced spans (install-free)");
  console.log(`otlp-export-smoke: built ${spans.length} OTel-shaped spans install-free.`);

  let otel;
  try {
    otel = await import("@opentelemetry/sdk-trace-base");
  } catch {
    console.error("otlp-export-smoke: @opentelemetry/* is not installed (future target). The spans above would be exported via an OTLP exporter. Refusing loudly rather than faking a real export.");
    process.exit(1);
  }
  console.log("otlp-export-smoke: OTel SDK present (" + typeof otel + "). A real OTLP export of the spans is the future deliverable.");
}

main().catch((e) => { console.error("otlp-export-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
