// T4 (M5) — OTel-shaped observability. toSpans derives spans from a recorded
// session's inspection: a root `turn` span + child spans per effect (intent→result)
// + the terminal marker span, with DETERMINISTIC spanIds (sessionId#seq, no RNG)
// and timing read from record.ts (allowed — observability; only reducers/step may
// not read ts). Spans are derived from the journal and NEVER re-enter replayed
// state (the recording run stays assertReplay-clean). Emitted to an injected sink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, harnessProgram, defaultBundle, canonicalize } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json, PerformerRegistry } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { inspectSession } from "@irisrun/inspect";
import { toSpans, collectingSink, type Span } from "@irisrun/observe";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

function performers(safeTools: string[]): { perf: PerformerRegistry; invariants: ReturnType<typeof defaultBundle>["invariants"] } {
  const bundle = defaultBundle({ safeTools });
  return {
    invariants: bundle.invariants,
    perf: {
      tactic: bundle.tacticPerformer,
      model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
      tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
      signal_recv: makeFakeSignal(true),
    },
  };
}

// finished = park (HITL) then resume; the recording run is assertReplay:true, so a
// clean finish proves replay determinism is intact (spans are computed afterward).
async function recordFinished(store: MemoryStateStore): Promise<void> {
  const { perf, invariants } = performers([]);
  const deps = (): EngineDeps<HarnessState> => ({
    store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants }), performers: perf,
    defDigest: "d", holderId: "H", assertReplay: true,
  });
  assert.equal((await runTurn(deps(), "s")).status, "parked");
  assert.equal((await runTurn(deps(), "s")).status, "finished");
}

async function recordParked(store: MemoryStateStore): Promise<void> {
  const { perf, invariants } = performers([]);
  const deps: EngineDeps<HarnessState> = {
    store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants }), performers: perf,
    defDigest: "d", holderId: "H", assertReplay: true,
  };
  assert.equal((await runTurn(deps, "p")).status, "parked");
}

test("T4: toSpans yields a root turn span + child effect spans + the terminal finish span; deterministic spanIds; emitted to a sink", async () => {
  const store = new MemoryStateStore();
  await recordFinished(store);
  const insp = await inspectSession(store, "s");
  const spans = toSpans(insp);

  const root = spans.find((s) => s.name === "turn");
  assert.ok(root, "a root turn span exists");
  assert.equal(root!.parentSpanId, undefined, "the root has no parent");
  assert.equal(root!.spanId, "s#turn");
  assert.equal(root!.statusCode, "OK", "a finished turn is OK");

  const effectSpans = spans.filter((s) => s.name.startsWith("effect:"));
  assert.ok(effectSpans.length > 0, "child effect spans exist");
  assert.ok(effectSpans.every((s) => s.parentSpanId === "s#turn"), "effect spans parent to the root turn");
  assert.ok(spans.some((s) => s.name === "marker:finish"), "the terminal finish marker is spanned");

  // emit to an injected sink
  const { sink, spans: collected } = collectingSink();
  await sink.export(spans);
  assert.equal(collected.length, spans.length);

  // DETERMINISTIC: re-inspecting + re-spanning the same store is byte-identical
  const insp2 = await inspectSession(store, "s");
  assert.equal(canonicalize(toSpans(insp2) as unknown as Json), canonicalize(spans as unknown as Json));

  // READ-ONLY: spanning did not mutate the journal/inspection (re-inspect stable)
  assert.equal(canonicalize(insp as unknown as Json), canonicalize(insp2 as unknown as Json));
});

test("T4: a parked turn is spanned up to the park (marker:wait, no finish; root UNSET)", async () => {
  const store = new MemoryStateStore();
  await recordParked(store);
  const spans: Span[] = toSpans(await inspectSession(store, "p"));
  assert.ok(spans.some((s) => s.name === "marker:wait"), "the park is spanned");
  assert.ok(!spans.some((s) => s.name === "marker:finish"), "a parked turn has no finish span");
  assert.equal(spans.find((s) => s.name === "turn")!.statusCode, "UNSET", "an unfinished turn is not OK");
});
