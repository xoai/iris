// Reference bridge e2e + conformance. The bridge SDK (@irisrun/bridge) drives a
// conversation through an in-process Iris REST channel, proving token adoption/
// rotation across turns and a stable conversation→session map. Also runs the SDK's
// own conformance suite (against its in-package fake channel) + a teeth check, and
// pins that the SDK imports nothing from @irisrun (it only speaks HTTP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeBridgeSession, runBridgeConformance, register } from "@irisrun/bridge";
import { makeBridgeDemoChannel } from "../examples/bridge-reference.ts";

// The SDK's own session-discipline conformance (token adoption/rotation, independent
// conversations, clean restart) against the in-package fake channel — no server.
register(runBridgeConformance(), test);

test("bridge conformance has teeth: a session that never adopts the rotated token fails", async () => {
  // a broken session that always reports turn 0 (ignores the channel's rotation)
  const brokenSession = () => ({
    async onMessage(inbound: { conversationId: string; text: string }) {
      return { conversationId: inbound.conversationId, status: "finished", output: { turn: 0 } };
    },
  });
  const cases = runBridgeConformance(brokenSession);
  let failures = 0;
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failures += 1;
    }
  }
  assert.ok(failures > 0, "a session that never advances must fail the two-turn case");
});

// --- e2e against the REAL in-process Iris REST channel ----------------------

test("bridge: a two-turn conversation flows through the bridge; the session continues across turns", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeBridgeSession({ baseUrl });
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
    const bridge = makeBridgeSession({ baseUrl });
    const a1 = await bridge.onMessage({ conversationId: "A", text: "x" });
    const b1 = await bridge.onMessage({ conversationId: "B", text: "y" });
    const a2 = await bridge.onMessage({ conversationId: "A", text: "x" });
    assert.deepEqual(a1.output, { turn: 0 });
    assert.deepEqual(b1.output, { turn: 0 }, "B starts its own session");
    assert.deepEqual(a2.output, { turn: 1 }, "A continues independently of B");
  } finally {
    await channel.close();
  }
});

test("bridge: a fresh bridge against a new server starts a clean session (no cross-server token reuse)", async () => {
  const ch1 = makeBridgeDemoChannel();
  const base1 = await ch1.listen();
  const bridge = makeBridgeSession({ baseUrl: base1 });
  await bridge.onMessage({ conversationId: "C", text: "hi" });
  await ch1.close();

  const ch2 = makeBridgeDemoChannel();
  const base2 = await ch2.listen();
  try {
    const freshBridge = makeBridgeSession({ baseUrl: base2 });
    const r = await freshBridge.onMessage({ conversationId: "C", text: "hi again" });
    assert.equal(r.status, "finished");
    assert.deepEqual(r.output, { turn: 0 }, "a fresh bridge against a new server starts cleanly");
  } finally {
    await ch2.close();
  }
});

// --- purity: the SDK speaks only HTTP — its source imports zero @irisrun ------

test("the @irisrun/bridge SDK imports NOTHING from @irisrun/* (a bridge needs only the wire protocol)", () => {
  const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const f of ["session.ts", "platform.ts", "conformance.ts", "index.ts"]) {
    const src = readFileSync(join(ROOT, "packages", "bridge", "src", f), "utf8");
    const importsIris = /\bfrom\s+["']@irisrun\//.test(src) || /\bimport\s*\(\s*["']@irisrun\//.test(src);
    assert.ok(!importsIris, `@irisrun/bridge/src/${f} must import no @irisrun package — the SDK only speaks HTTP`);
  }
});
