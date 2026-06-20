// Reference bridge e2e (roadmap v0.2 §12, plan T12.2) — the §12 done-when: "a
// documented bridge pattern + one reference bridge; additional platforms need no core
// changes." Drives a TWO-turn conversation through the fetch-only webhook bridge
// against an in-process Iris REST channel, proving token adoption/rotation across turns
// and a stable conversation→session map — with ZERO core changes (asserted: the bridge
// module imports nothing from @irisrun/*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeWebhookBridge } from "./manual/webhook-bridge.ts";
import { makeBridgeDemoChannel } from "./manual/bridge-reference.ts";

test("bridge: a two-turn conversation flows through the bridge; the session continues across turns", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeWebhookBridge({ baseUrl });
    const convo = "telegram:chat-42";
    const r1 = await bridge.onMessage({ conversationId: convo, text: "hello" });
    assert.equal(r1.status, "finished");
    assert.deepEqual(r1.output, { turn: 0 }, "first turn output");
    const r2 = await bridge.onMessage({ conversationId: convo, text: "again" });
    assert.equal(r2.status, "finished");
    assert.deepEqual(r2.output, { turn: 1 }, "second turn continues the SAME session (token adopted+rotated)");
  } finally {
    await channel.close();
  }
});

test("bridge: two different conversations map to two independent sessions", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeWebhookBridge({ baseUrl });
    const a1 = await bridge.onMessage({ conversationId: "A", text: "x" });
    const b1 = await bridge.onMessage({ conversationId: "B", text: "y" });
    const a2 = await bridge.onMessage({ conversationId: "A", text: "x" });
    // A advanced to turn 1; B is independent at turn 0 — separate session state.
    assert.deepEqual(a1.output, { turn: 0 });
    assert.deepEqual(b1.output, { turn: 0 }, "B starts its own session");
    assert.deepEqual(a2.output, { turn: 1 }, "A continues independently of B");
  } finally {
    await channel.close();
  }
});

test("bridge: a fresh bridge against a new server starts a clean session (no cross-server token reuse)", async () => {
  // First server: establish a conversation, then it goes away.
  const ch1 = makeBridgeDemoChannel();
  const base1 = await ch1.listen();
  const bridge = makeWebhookBridge({ baseUrl: base1 });
  await bridge.onMessage({ conversationId: "C", text: "hi" });
  await ch1.close();

  // A new server has an empty token map. A new bridge instance (the realistic
  // post-restart shape) holds no stale handle, so the SAME conversation id STARTS a
  // fresh session cleanly rather than presenting a token the new server never issued.
  // (Reusing the OLD bridge's stale handle would instead hit the channel's loud 404/409
  // — the single-use discipline the channel enforces; this test pins the clean path.)
  const ch2 = makeBridgeDemoChannel();
  const base2 = await ch2.listen();
  try {
    const freshBridge = makeWebhookBridge({ baseUrl: base2 });
    const r = await freshBridge.onMessage({ conversationId: "C", text: "hi again" });
    assert.equal(r.status, "finished");
    assert.deepEqual(r.output, { turn: 0 }, "a fresh bridge against a new server starts cleanly");
  } finally {
    await ch2.close();
  }
});

test("bridge: the reference bridge imports NOTHING from @irisrun/* (any-language, zero core changes)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manual", "webhook-bridge.ts"), "utf8");
  // Match real ES import statements only (a comment may mention the scope by name).
  const importsIris = /\bfrom\s+["']@irisrun\//.test(src) || /\bimport\s*\(\s*["']@irisrun\//.test(src);
  assert.ok(!importsIris, "webhook-bridge.ts must not import any @irisrun package — a bridge needs only the wire protocol");
  assert.ok(/\bfetch\b/.test(src), "the bridge speaks the wire protocol via fetch");
});
