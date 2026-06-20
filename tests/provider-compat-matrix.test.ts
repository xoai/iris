// Per-endpoint conformance — the §9 done-when realized (plan T9.3): "a documented
// matrix where each listed endpoint passes (or is flagged against) the record-replay
// conformance suite." For EVERY entry, the matching adapter is built with the entry's
// baseUrl and an injected fetch returning that protocol's representative response; the
// result MUST canonicalize to the stable ModelCallResult and the POST MUST go to the
// entry's baseUrl verbatim. This is the same canonicalization proven in
// tests/provider-canonicalization.test.ts, now pinned per endpoint so the
// matrix cannot rot into a false promise. No live keys — crafted bodies via fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import { COMPAT_MATRIX, type CompatEntry } from "@irisrun/provider-compat";
import { openaiModelPerformer } from "@irisrun/provider-openai";
import { anthropicModelPerformer } from "@irisrun/provider-anthropic";

interface Result {
  role: string;
  content: string;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}
interface Captured {
  url: string;
}

const REQ: Json = { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 32 };

// Representative HTTP-200 bodies for each protocol (content "Hi there", usage 5/2).
function representativeBody(protocol: string): unknown {
  if (protocol === "openai") {
    return {
      choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hi there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  };
}

function captureFetch(body: unknown, captured: { value: Captured | null }): typeof fetch {
  return (async (url: string) => {
    captured.value = { url };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

function buildPerformer(e: CompatEntry, fetchImpl: typeof fetch) {
  const opts = { apiKey: "test-key", fetchImpl, baseUrl: e.baseUrl };
  return e.protocol === "openai" ? openaiModelPerformer(opts) : anthropicModelPerformer(opts);
}

// Each entry, regardless of replaySafety, must canonicalize its protocol's response
// to the SAME stable shape — that is the record-replay core. The replaySafety flag is
// about auth/URL/transport adaptation (asserted separately below), not response shape.
for (const e of COMPAT_MATRIX) {
  test(`compat-conformance: ${e.id} (${e.protocol}) canonicalizes + POSTs to its baseUrl`, async () => {
    const cap: { value: Captured | null } = { value: null };
    const perf = buildPerformer(e, captureFetch(representativeBody(e.protocol), cap));
    const out = await perf(REQ);
    assert.ok(out.ok, `${e.id}: model_call must succeed on a representative response`);
    const r = out.value as unknown as Result;
    assert.equal(r.role, "assistant", `${e.id}: role`);
    assert.equal(r.content, "Hi there", `${e.id}: content canonicalized`);
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 2 }, `${e.id}: usage canonicalized`);
    assert.equal(r.stopReason, e.protocol === "openai" ? "stop" : "end_turn", `${e.id}: stopReason`);
    // result shape is EXACTLY the four port fields (the replay-safe contract)
    assert.deepEqual(Object.keys(r).sort(), ["content", "role", "stopReason", "usage"], `${e.id}: stable shape`);
    // the adapter POSTed to the entry's baseUrl verbatim — the matrix URL is real
    assert.equal(cap.value?.url, e.baseUrl, `${e.id}: POST went to the matrix baseUrl`);
  });
}

test("compat-conformance: replay-safe ⇒ no note; known-divergent ⇒ note flags the divergence", () => {
  // The done-when's "(or is flagged against)" half: known-divergent endpoints are
  // explicitly flagged so a user knows they need auth/URL/transport adaptation.
  for (const e of COMPAT_MATRIX) {
    if (e.replaySafety === "replay-safe") {
      assert.equal(e.note, "", `${e.id} replay-safe must carry no caveat`);
    } else {
      assert.ok(e.note.length > 0, `${e.id} known-divergent must be flagged with a note`);
    }
  }
});
