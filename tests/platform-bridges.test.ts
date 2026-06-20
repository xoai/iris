// Reference platform bridges (roadmap v0.2 §12 extension): Discord, Telegram, Teams as
// thin adapters over the generic REST-protocol bridge — proving "additional platforms
// need no core changes" three times, with REAL per-platform auth (Ed25519 / secret
// token / Outgoing-Webhook HMAC) and end-to-end turns against an in-process REST channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeBridgeDemoChannel } from "./manual/bridge-reference.ts";
import { makeDiscordBridge } from "./manual/bridges/discord.ts";
import { makeTelegramBridge } from "./manual/bridges/telegram.ts";
import { makeTeamsBridge } from "./manual/bridges/teams.ts";

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

// ── Telegram (secret token) ──────────────────────────────────────────────────

const TG_SECRET = "telegram-webhook-secret";
function tgHeaders(secret = TG_SECRET) {
  return { "x-telegram-bot-api-secret-token": secret };
}

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
    // a non-text update (e.g. a sticker) with valid auth is ignored, not crashed
    const nonText = JSON.stringify({ message: { chat: { id: 1 } } });
    const r = await bridge.handle(tgHeaders(), nonText);
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(r.body), /ignored/);
  } finally {
    await channel.close();
  }
});

// ── Microsoft Teams (Outgoing-Webhook HMAC) ──────────────────────────────────

const TEAMS_SECRET_B64 = Buffer.from("teams-shared-secret-bytes").toString("base64");
function teamsAuth(rawBody: string, secretB64 = TEAMS_SECRET_B64) {
  const sig = createHmac("sha256", Buffer.from(secretB64, "base64")).update(Buffer.from(rawBody, "utf8")).digest("base64");
  return { authorization: `HMAC ${sig}` };
}

test("teams bridge: a valid HMAC message drives the session and strips the @mention", async () => {
  // Capture the body the bridge POSTs to the channel, to prove the stripped text is sent.
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
    // wrong secret → wrong HMAC → 401
    const wrongSecret = Buffer.from("not-the-secret").toString("base64");
    assert.equal((await bridge.handle(teamsAuth(body, wrongSecret), body)).status, 401);
    // valid auth but a non-message activity → ignored
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

// ── the §12 invariant: bridges import NOTHING from @irisrun/* ─────────────────

test("platform bridges + harness import nothing from @irisrun/* (any-language, zero core changes)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "manual", "platform-bridge.ts"),
    join(here, "manual", "bridges", "discord.ts"),
    join(here, "manual", "bridges", "telegram.ts"),
    join(here, "manual", "bridges", "teams.ts"),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const staticImport = /\bfrom\s+["']@irisrun\//.test(src);
    const dynImport = /\bimport\s*\(\s*["']@irisrun\//.test(src);
    assert.ok(!staticImport && !dynImport, `${f} must not import any @irisrun package — a bridge needs only the wire protocol`);
  }
});
