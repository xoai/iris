// T2 (M5) — the journal/decision viewer. `inspectSession` reads a recorded
// session (snapshot + journal) from a StateStore and renders the deterministic
// decision/effect/marker timeline, keyed by the stable sessionId. READ-ONLY: it
// re-derives the governing digest snapshot-safely (mirrors pin.ts:latestRecord)
// and never writes. Re-inspecting the same store is byte-identical (canonicalize).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, harnessProgram, defaultBundle, canonicalize } from "@irisrun/core";
import type { EngineDeps, HarnessState, Json, PerformerRegistry } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { inspectSession, renderTimeline } from "@irisrun/inspect";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeFakeTool } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

const bundle = defaultBundle({ safeTools: [] }); // "rm" gated → park on HITL, resume → finish

// Record a park→resume harness session on a fresh store at `threshold`. Performers
// persist across the two turns (so the model index advances 0→1).
async function recordHitlSession(store: MemoryStateStore, threshold: number): Promise<void> {
  const performers: PerformerRegistry = {
    tactic: bundle.tacticPerformer,
    model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
    tool_call: makeFakeTool(() => ({ ok: true, value: { done: 1 } })),
    signal_recv: makeFakeSignal(true),
  };
  const deps = (): EngineDeps<HarnessState> => ({
    store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants: bundle.invariants }),
    performers, defDigest: "d", holderId: "H", assertReplay: true, snapshotThreshold: threshold,
  });
  const t1 = await runTurn(deps(), "s");
  assert.equal(t1.status, "parked");
  const t2 = await runTurn(deps(), "s");
  assert.equal(t2.status, "finished");
}

test("T2 (a) default-threshold session: full timeline + counts + terminal:finished + governingDigest; byte-identical re-inspect", async () => {
  const store = new MemoryStateStore();
  await recordHitlSession(store, 64); // high threshold → no truncation, full journal

  const insp = await inspectSession(store, "s");
  assert.equal(insp.sessionId, "s");
  assert.equal(insp.governingDigest, "d", "governing digest = the latest record's defDigest");
  assert.equal(insp.terminal, "finished");
  // a real harness turn emits tactic/model/tool effects + markers — the timeline is non-trivial
  assert.ok(insp.records.length >= 6, `expected a rich timeline, got ${insp.records.length}`);
  assert.ok(insp.counts.effects > 0 && insp.counts.results > 0 && insp.counts.markers > 0);
  // every effect intent is paired by a result (no dangling) in a finished session
  assert.equal(insp.counts.effects, insp.counts.results, "every effect intent has a result");
  // a text rendering exists, one line per record (plus a header)
  const text = renderTimeline(insp);
  assert.ok(text.includes("#0 "), "timeline renders seq-numbered lines");

  // READ-ONLY + deterministic: re-inspecting the same store is byte-identical
  const again = await inspectSession(store, "s");
  assert.equal(canonicalize(insp as unknown as Json), canonicalize(again as unknown as Json));
  assert.equal(renderTimeline(insp), renderTimeline(again));
});

test("T2 (b) low-threshold session: snapshot+truncate occurs, yet governingDigest still resolves (snapshot-safe)", async () => {
  const store = new MemoryStateStore();
  await recordHitlSession(store, 2); // low threshold → snapshot + truncate crossed

  const insp = await inspectSession(store, "s");
  assert.notEqual(insp.snapshotUpTo, null, "a snapshot boundary was crossed");
  assert.equal(insp.governingDigest, "d", "governing digest resolves post-truncation (not empty)");
  // the timeline starts AFTER the snapshot (the truncated prefix is gone)
  assert.ok(insp.records.length > 0, "post-snapshot tail is present");
  assert.equal(insp.records[0].seq, (insp.snapshotUpTo as number) + 1, "timeline starts at snapshotUpTo+1");
  assert.equal(insp.terminal, "finished");
});

test("T2 (c) a never-started session inspects to an empty-but-valid result (no throw)", async () => {
  const store = new MemoryStateStore();
  const insp = await inspectSession(store, "ghost");
  assert.equal(insp.sessionId, "ghost");
  assert.equal(insp.governingDigest, null);
  assert.equal(insp.snapshotUpTo, null);
  assert.deepEqual(insp.records, []);
  assert.equal(insp.terminal, "open");
  assert.equal(typeof renderTimeline(insp), "string");
});
