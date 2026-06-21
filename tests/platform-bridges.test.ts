// Reference platform bridges: Discord, Telegram, Teams as thin adapters over the
// @irisrun/bridge SDK — proving "additional platforms need no core changes" three
// times, with REAL per-platform auth (Ed25519 / secret token / Outgoing-Webhook HMAC),
// end-to-end turns against an in-process REST channel, AND each adapter run through the
// SDK's adapter conformance (verify accepts/rejects, parse maps, verify-first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAdapterConformance, register } from "@irisrun/bridge";
import { makeBridgeDemoChannel } from "./examples/bridge-reference.ts";
import { makeDiscordBridge, discordAdapter } from "./examples/bridges/discord.ts";
import { makeTelegramBridge, telegramAdapter } from "./examples/bridges/telegram.ts";
import { makeTeamsBridge, teamsAdapter } from "./examples/bridges/teams.ts";

// ── Discord (Ed25519) ────────────────────────────────────────────────────────

function discordKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { publicKeyHex: der.subarray(12).toString("hex"), privateKey };
}
function discordHeaders(privateKey: ReturnType<typeof discordKeys>["privateKey"], rawBody: string, ts = "1700000000") {
  const sig = edSign(null, Buffer.from(ts + rawBody, "utf8"), privateKey).toString("hex");
  return { "x-signature-ed25519": sig, "x-signature-timestamp": ts };
}

// ── Telegram (secret token) ──────────────────────────────────────────────────

const TG_SECRET = "telegram-webhook-secret";
function tgHeaders(secret = TG_SECRET) {
  return { "x-telegram-bot-api-secret-token": secret };
}

// ── Microsoft Teams (Outgoing-Webhook HMAC) ──────────────────────────────────

const TEAMS_SECRET_B64 = Buffer.from("teams-shared-secret-bytes").toString("base64");
function teamsAuth(rawBody: string, secretB64 = TEAMS_SECRET_B64) {
  const sig = createHmac("sha256", Buffer.from(secretB64, "base64")).update(Buffer.from(rawBody, "utf8")).digest("base64");
  return { authorization: `HMAC ${sig}` };
}

// ── Adapter conformance: verify accepts/rejects, parse maps, verify-first ─────

{
  const { publicKeyHex, privateKey } = discordKeys();
  const body = JSON.stringify({ type: 2, channel_id: "chan-7", data: { name: "ask", options: [{ value: "hi" }] } });
  register(
    runAdapterConformance(discordAdapter({ publicKeyHex }), {
      valid: { headers: discordHeaders(privateKey, body), rawBody: body },
      tampered: { headers: { "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": "1700000000" }, rawBody: body },
      expect: { conversationId: "chan-7", text: "hi" },
    }),
    test,
  );
}
{
  const body = JSON.stringify({ message: { chat: { id: 4242 }, text: "hi" } });
  register(
    runAdapterConformance(telegramAdapter({ secretToken: TG_SECRET }), {
      valid: { headers: tgHeaders(), rawBody: body },
      tampered: { headers: tgHeaders("WRONG"), rawBody: body },
      expect: { conversationId: "4242", text: "hi" },
    }),
    test,
  );
}
{
  const body = JSON.stringify({ type: "message", text: "<at>Bot</at> hi", conversation: { id: "19:abc" } });
  register(
    runAdapterConformance(teamsAdapter({ sharedSecret: TEAMS_SECRET_B64 }), {
      valid: { headers: teamsAuth(body), rawBody: body },
      tampered: { headers: teamsAuth(body, Buffer.from("not-the-secret").toString("base64")), rawBody: body },
      expect: { conversationId: "19:abc", text: "hi" },
    }),
    test,
  );
}

// ── e2e: Discord ─────────────────────────────────────────────────────────────

test("discord bridge: a signed slash command drives the session; two turns advance (token adopted)", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const { publicKeyHex, privateKey } = discordKeys();
    const bridge = makeDiscordBridge({ baseUrl, publicKeyHex });
    const body = JSON.stringify({ type: 2, channel_id: "chan-7", data: { name: "ask", options: [{ value: "hi" }] } });
    const content = (r: { body: unknown }): string => (r.body as { data?: { content?: string } }).data?.content ?? "";
    const r1 = await bridge.handle(discordHeaders(privateKey, body), body);
    assert.equal(r1.status, 200);
    assert.match(content(r1), /"turn":0/, "first turn output reaches Discord");
    const r2 = await bridge.handle(discordHeaders(privateKey, body), body);
    assert.match(content(r2), /"turn":1/, "second turn continues the same session via the adapter");
  } finally {
    await channel.close();
  }
});

test("discord bridge: a PING (type 1) is answered with a PONG (type 1), no turn", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const { publicKeyHex, privateKey } = discordKeys();
    const bridge = makeDiscordBridge({ baseUrl, publicKeyHex });
    const body = JSON.stringify({ type: 1 });
    const r = await bridge.handle(discordHeaders(privateKey, body), body);
    assert.deepEqual(r.body, { type: 1 }, "PING → PONG");
  } finally {
    await channel.close();
  }
});

test("discord bridge: a bad/absent signature is refused with 401 (body not processed)", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const { publicKeyHex } = discordKeys();
    const bridge = makeDiscordBridge({ baseUrl, publicKeyHex });
    const body = JSON.stringify({ type: 2, channel_id: "c", data: { name: "ask" } });
    const bad = await bridge.handle({ "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": "1700000000" }, body);
    assert.equal(bad.status, 401);
    const absent = await bridge.handle({}, body);
    assert.equal(absent.status, 401);
  } finally {
    await channel.close();
  }
});

// ── e2e: Telegram ────────────────────────────────────────────────────────────

test("telegram bridge: a text message with the right secret token drives two turns", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeTelegramBridge({ baseUrl, secretToken: TG_SECRET });
    const body = JSON.stringify({ message: { chat: { id: 4242 }, text: "hi", from: { id: 9 } } });
    const r1 = await bridge.handle(tgHeaders(), body);
    assert.equal(r1.status, 200);
    assert.equal((r1.body as { method?: string }).method, "sendMessage");
    assert.equal((r1.body as { chat_id?: string }).chat_id, "4242", "chat id round-trips");
    assert.match((r1.body as { text?: string }).text ?? "", /"turn":0/);
    const r2 = await bridge.handle(tgHeaders(), body);
    assert.match((r2.body as { text?: string }).text ?? "", /"turn":1/, "same chat continues the session");
  } finally {
    await channel.close();
  }
});

test("telegram bridge: a wrong secret token is refused 401; a non-text update is ignored", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeTelegramBridge({ baseUrl, secretToken: TG_SECRET });
    const body = JSON.stringify({ message: { chat: { id: 1 }, text: "hi" } });
    assert.equal((await bridge.handle(tgHeaders("WRONG"), body)).status, 401);
    const nonText = JSON.stringify({ message: { chat: { id: 1 } } });
    const r = await bridge.handle(tgHeaders(), nonText);
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(r.body), /ignored/);
  } finally {
    await channel.close();
  }
});

// ── e2e: Microsoft Teams ─────────────────────────────────────────────────────

test("teams bridge: a valid HMAC message drives the session and strips the @mention", async () => {
  const captured: { body: { messages?: Array<{ content?: string }> } | null } = { body: null };
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ sessionId: "s", continuationToken: "t", status: "finished", output: { turn: 0 } }) };
  }) as unknown as typeof fetch;

  const bridge = makeTeamsBridge({ baseUrl: "http://unused.example", sharedSecret: TEAMS_SECRET_B64, fetchImpl });
  const body = JSON.stringify({ type: "message", text: "<at>SomeBot</at> status", conversation: { id: "19:abc" }, from: { id: "u1" } });
  const r = await bridge.handle(teamsAuth(body), body);
  assert.equal(r.status, 200);
  assert.equal((r.body as { type?: string }).type, "message");
  assert.equal(captured.body?.messages?.[0]?.content, "status", "the @mention was stripped before reaching the channel");
});

test("teams bridge: a wrong HMAC is refused 401; a non-message activity is ignored", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeTeamsBridge({ baseUrl, sharedSecret: TEAMS_SECRET_B64 });
    const body = JSON.stringify({ type: "message", text: "hi", conversation: { id: "19:x" } });
    const wrongSecret = Buffer.from("not-the-secret").toString("base64");
    assert.equal((await bridge.handle(teamsAuth(body, wrongSecret), body)).status, 401);
    assert.equal((await bridge.handle({ authorization: "HMAC A" }, body)).status, 401);
    assert.equal((await bridge.handle({ authorization: "not-hmac-scheme" }, body)).status, 401);
    const ping = JSON.stringify({ type: "conversationUpdate", conversation: { id: "19:x" } });
    const r = await bridge.handle(teamsAuth(ping), ping);
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(r.body), /ignored/);
  } finally {
    await channel.close();
  }
});

test("teams bridge: a real end-to-end turn against the in-process channel", async () => {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeTeamsBridge({ baseUrl, sharedSecret: TEAMS_SECRET_B64 });
    const body = JSON.stringify({ type: "message", text: "<at>Iris</at> go", conversation: { id: "19:real" } });
    const r = await bridge.handle(teamsAuth(body), body);
    assert.equal(r.status, 200);
    assert.match((r.body as { text?: string }).text ?? "", /"turn":0/, "the agent ran and replied through Teams");
  } finally {
    await channel.close();
  }
});

// ── purity: an adapter imports no @irisrun/* except the optional @irisrun/bridge SDK ─

test("platform adapters import no @irisrun/* except the optional @irisrun/bridge SDK", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "examples", "bridges", "discord.ts"),
    join(here, "examples", "bridges", "telegram.ts"),
    join(here, "examples", "bridges", "teams.ts"),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const irisImports = [...src.matchAll(/\bfrom\s+["'](@irisrun\/[^"']+)["']/g)].map((m) => m[1]);
    for (const imp of irisImports) {
      assert.equal(imp, "@irisrun/bridge", `${f} may import only @irisrun/bridge among @irisrun packages, found ${imp}`);
    }
  }
});
