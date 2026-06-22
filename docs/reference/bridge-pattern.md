# Bridge pattern — Discord, Telegram, and the rest (normative)

How to reach a chat platform **without** a first-party Iris package. Matching another
framework's channel list is pure parity and turns the project into an integrations
shop; the moat is durable, portable, verifiable sessions, not breadth. So beyond the
one strategic channel ([Slack, for durable HITL](../channels.md#slack--durable-human-in-the-loop)),
every other platform is a **bridge**: an external process that speaks the existing
Iris REST channel protocol. New platforms need **no core changes**.

> A reference doc, not a tutorial — start at [Channels](../channels.md).

## What a bridge is

A bridge is a small, standalone process (in **any language**) that:

1. **Owns the platform.** Its OAuth, event model, message/threading format,
   interactive components, and rate limits — none of which Iris should carry.
2. **Speaks only the wire protocol.** It calls the Iris REST channel —
   `POST /v1/session` to start, `POST /v1/session/{sessionId}/message` to continue —
   and needs nothing from the Iris runtime. The optional **`@irisrun/bridge`** SDK
   handles the session/token choreography for you (and itself imports zero `@irisrun/*`,
   speaking only HTTP), but a bridge can equally be written in any language with no SDK.
3. **Mirrors the two-identifier discipline.** It holds a
   `platformConversationId → { sessionId, continuationToken }` map and **adopts the
   rotated token** the channel returns on every turn — the same single-use rule the
   channel enforces, honored from outside.

```
Discord / Telegram / webhook  ──(platform API)──►  BRIDGE  ──(HTTP, wire protocol)──►  iris serve
        ◄───────── reply ──────────                       ◄──── {sessionId, continuationToken, output} ────
```

## The contract a bridge MUST honor

- **Map** each platform conversation to one Iris session (start on first message;
  continue thereafter).
- **Adopt** the rotated `continuationToken` from each response; present it on the next
  turn. Treat it as single-use.
- **Handle loud refusals.** A stale/missing token or unknown session is a loud 4xx
  (the channel never silently succeeds). A robust bridge starts a fresh session rather
  than reusing a token across a server it can no longer reach — see the reference test.
- **Carry no durable state of its own** that it cannot rebuild. The durable session is
  the Iris journal; the bridge's map is a convenience cache.

## The SDK — `@irisrun/bridge`

`makeBridgeSession({ baseUrl })` maps `{conversationId, text}` ↔ the REST channel using
only `fetch`, handling token adoption + rotation. `makePlatformBridge(adapter, { baseUrl })`
adds the verify→parse→drive→format harness for a platform. The package is zero-dep and
imports nothing from `@irisrun/*`. Run the demo:

```sh
npm run demo:bridge   # stands up an in-process channel and drives a 2-turn conversation through the bridge
```

**Certify a bridge** with the suite the SDK ships — `runBridgeConformance()` (token
adoption/rotation, independent conversations, clean restart, against an in-package fake
channel) and `runAdapterConformance(adapter, vectors)` (verify accepts/rejects, parse
maps, verify-first):

```ts
import { test } from "node:test";
import { runBridgeConformance, runAdapterConformance, register } from "@irisrun/bridge";
register(runBridgeConformance(), test);
register(runAdapterConformance(myAdapter, vectors), test);
```

`tests/bridge-reference.test.ts` drives the SDK end-to-end against a real in-process
channel and runs the conformance suite; a Discord or Telegram bridge is the same shape
with a platform adapter in front — **no Iris core changes**.

## Worked examples — Discord, Telegram, Teams

Three reference adapters show the pattern with **real per-platform auth**, each a thin
adapter (`verify` + `parse` inbound + `format` outbound) over the SDK's
`makePlatformBridge`. They import **nothing from `@irisrun/*` except the optional
`@irisrun/bridge` SDK** (a test asserts it) — adding a platform is an adapter, never a
core change. They stay **reference examples** (copy and adapt), not maintained
first-party packages, so Iris never owns a platform's API drift.

| Platform | File | Inbound auth | Inbound → text | Outbound |
| --- | --- | --- | --- | --- |
| **Discord** | `tests/examples/bridges/discord.ts` | Ed25519 over `timestamp + body` vs the app public key (`X-Signature-Ed25519`); PING→PONG | slash command (`type:2`) → `data.options[0].value`; conversation = `channel_id` | interaction response `{type:4, data:{content}}` |
| **Telegram** | `tests/examples/bridges/telegram.ts` | `X-Telegram-Bot-Api-Secret-Token` (constant-time) | `message.text`; conversation = `message.chat.id` | webhook-response `{method:"sendMessage", chat_id, text}` |
| **Teams** | `tests/examples/bridges/teams.ts` | Outgoing-Webhook HMAC-SHA256 (base64) `Authorization: HMAC <sig>` | Activity `text` (leading `<at>…</at>` mention stripped); conversation = `conversation.id` | Activity `{type:"message", text}` |
| **WhatsApp** | `tests/examples/bridges/whatsapp.ts` | Meta Cloud API `X-Hub-Signature-256` = HMAC-SHA256(app secret, raw body) | `entry[].changes[].value.messages[0].text.body`; conversation = sender `from` | Cloud-API send `{messaging_product, to, type:"text", text:{body}}` |
| **Twilio** | `tests/examples/bridges/twilio.ts` | `X-Twilio-Signature` = HMAC-SHA1 base64 over the **configured** webhook URL + sorted POST params (URL isn't in `verify`, so it's config) | form `Body`; conversation = `From` | TwiML `<Response><Message>…</Message></Response>` (string) |
| **Google Chat** | `tests/examples/bridges/googlechat.ts` | shared verification token in `Authorization` (constant-time; full Bearer-JWT/JWKS deferred) | `MESSAGE` event `message.text`; conversation = `space.name` | `{text}` |

Each enforces the same discipline as the SDK: **verify first** (an unverified body is
never processed → 401), normalize, drive the durable session (adopting the rotated
token), format the reply. `tests/platform-bridges.test.ts` drives each end-to-end
against an in-process channel, runs `runAdapterConformance` on each adapter, rejects bad
auth, and pins that an adapter imports nothing `@irisrun/*` beyond the SDK.

**Operator setup** (documented, not code): register the Discord application command +
public key; `setWebhook` with a `secret_token` for Telegram; configure the Teams
Outgoing Webhook with its HMAC secret. Production Teams using the Bot Framework (rather
than an Outgoing Webhook) validates a JWT bearer against Azure AD — a heavier auth path
left to the integrator.

## Run a bridge forklessly — `iris bridge <module>`

A bridge module can export an `openBridge(opts)` factory (`@irisrun/bridge`'s `OpenBridge`)
that builds its `PlatformAdapter` from the environment — and `iris bridge <module>
--base-url <channelUrl>` loads it **by specifier** and serves it in front of a running
channel, exactly the way `--store`/`--channel` already load a store / in-process channel
without a fork. The CLI dynamic-imports the module (adding **no** dependency to Iris),
builds `makePlatformBridge(adapter, { baseUrl })`, and serves a `node:http` endpoint that
pipes each request to `bridge.handle(headers, rawBody)` (a string reply like Twilio's TwiML
is sent as `application/xml`; an object reply as JSON). All six reference adapters export
`openBridge`, reading their config from the environment (`DISCORD_PUBLIC_KEY` /
`TELEGRAM_SECRET_TOKEN` / `TEAMS_SHARED_SECRET` / `WHATSAPP_APP_SECRET` /
`TWILIO_AUTH_TOKEN`+`TWILIO_WEBHOOK_URL` / `GOOGLE_CHAT_TOKEN`):

```sh
iris serve ./image --port 8787 &     # the Iris REST channel
DISCORD_PUBLIC_KEY=<hex> iris bridge ./tests/examples/bridges/discord.ts --base-url http://127.0.0.1:8787
```

`OpenBridge` lives in `@irisrun/bridge` (not `@irisrun/sdk`) on purpose: a bridge author
then still depends on ONLY `@irisrun/bridge` — the import-discipline the examples here
uphold (`tests/platform-bridges.test.ts` pins it). `iris deploy` does not carry a forkless
bridge module (`bridge` is a separate verb, not a deploy flag).

## When to make it first-party instead

Almost never. Promote a bridge to a first-party channel only when the platform is the
one where the **moat itself** is demonstrated (durable, approval-gated, resumable
sessions) — which is exactly why Slack is first-party and the rest are bridges.
