// LIVE model-provider conformance tier ("done when": both
// adapters hold the recorded-effect contract against REAL, streaming,
// nondeterministic API responses). Gated: runs only with IRIS_LIVE_CONFORMANCE=1
// AND the provider key set; otherwise every case SKIPs (suite stays green here —
// no keys in this environment). Runnable the moment keys exist, with no code
// change. The keyless canonicalization + replay-fidelity proofs live in
// provider-canonicalization.test.ts and model-call-replay-fidelity.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, Performer } from "@irisrun/core";
import { anthropicModelPerformer, anthropicStreamingModelPerformer } from "@irisrun/provider-anthropic";
import { openaiModelPerformer, openaiStreamingModelPerformer } from "@irisrun/provider-openai";
import { liveGate } from "./lib/live-gate.ts";
import { recordThenResumeWithPoison } from "./lib/model-call-fidelity.ts";

interface Result {
  role: string;
  content: string;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface LiveProvider {
  name: string;
  envKey: string;
  model: string;
  buffered: (apiKey: string) => Performer;
  streaming: (apiKey: string, onDelta: (t: string) => void) => Performer;
}

const PROVIDERS: LiveProvider[] = [
  {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    model: process.env.IRIS_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    buffered: (apiKey) => anthropicModelPerformer({ apiKey }),
    streaming: (apiKey, onDelta) => anthropicStreamingModelPerformer({ apiKey, onDelta }),
  },
  {
    name: "openai",
    envKey: "OPENAI_API_KEY",
    model: process.env.IRIS_LIVE_OPENAI_MODEL ?? "gpt-4o-mini",
    buffered: (apiKey) => openaiModelPerformer({ apiKey }),
    streaming: (apiKey, onDelta) => openaiStreamingModelPerformer({ apiKey, onDelta }),
  },
];

// A tiny, cheap, deterministic-enough prompt. We do NOT assert exact text (the
// model is nondeterministic) — only that the canonical contract holds.
function req(model: string): Json {
  return {
    model,
    system: "Reply with a single short word.",
    messages: [{ role: "user", content: "Say hello." }],
    maxTokens: 16,
  };
}

const KNOWN_STOP = new Set(["end_turn", "stop", "max_tokens", "length", "tool_use", "tool_calls", "content_filter"]);

for (const p of PROVIDERS) {
  const gate = liveGate(p.envKey);

  test(`[live:${p.name}] buffered: real response canonicalizes to the stable shape`, { skip: gate.skip }, async () => {
    const out = await p.buffered(gate.apiKey)(req(p.model));
    assert.ok(out.ok, "live buffered call succeeded");
    const r = out.value as unknown as Result;
    assert.equal(r.role, "assistant");
    assert.equal(typeof r.content, "string");
    assert.ok(r.content.length > 0, "non-empty content");
    assert.ok(KNOWN_STOP.has(r.stopReason), `stopReason "${r.stopReason}" is a known value`);
    assert.ok(r.usage, "usage present");
    assert.ok(Number.isInteger(r.usage?.inputTokens) && (r.usage?.inputTokens ?? -1) >= 0, "inputTokens ≥ 0");
    assert.ok(Number.isInteger(r.usage?.outputTokens) && (r.usage?.outputTokens ?? -1) >= 0, "outputTokens ≥ 0");
  });

  test(`[live:${p.name}] streaming: deltas reconcile (content === join(deltas)) against a real stream`, { skip: gate.skip }, async () => {
    const deltas: string[] = [];
    const out = await p.streaming(gate.apiKey, (t) => deltas.push(t))(req(p.model));
    assert.ok(out.ok, "live streaming call succeeded");
    const r = out.value as unknown as Result;
    assert.ok(deltas.length >= 1, "at least one delta fired");
    assert.equal(r.content, deltas.join(""), "reconcile invariant holds on a real stream");
    assert.ok(KNOWN_STOP.has(r.stopReason), `stopReason "${r.stopReason}" is known`);
  });

  test(`[live:${p.name}] fidelity: a live model_call replays to the byte-identical captured value`, { skip: gate.skip }, async () => {
    // wrap the live buffered performer with a call counter to assert single-shot
    let calls = 0;
    const counted: Performer = async (request) => {
      calls += 1;
      return p.buffered(gate.apiKey)(request);
    };
    const run = await recordThenResumeWithPoison(counted);
    assert.ok(run.parkedOk, "original turn parked after the live model_call");
    assert.equal(calls, 1, "the live provider was called exactly once");
    assert.ok(run.finishedOk, "resume finished from the journal");
    assert.equal(run.poisonFired, 0, "resume never re-invoked the provider (read from the journal)");
    const reply = run.recordedReply as unknown as Result;
    assert.equal(typeof reply.content, "string");
    assert.ok(reply.content.length > 0, "the captured live reply replays intact");
  });
}
