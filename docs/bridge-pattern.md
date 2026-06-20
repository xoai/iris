# Bridge pattern — Discord, Telegram, and the rest (normative)

How to reach a chat platform **without** a first-party Iris package. Matching another
framework's channel list is pure parity and turns the project into an integrations
shop; the moat is durable, portable, verifiable sessions, not breadth. So beyond the
one strategic channel ([Slack, for durable HITL](./04-channels.md#slack--durable-human-in-the-loop)),
every other platform is a **bridge**: an external process that speaks the existing
Iris REST channel protocol. New platforms need **no core changes**.

> A reference doc, not a tutorial — start at [04 — Channels](./04-channels.md).

## What a bridge is

A bridge is a small, standalone process (in **any language**) that:

1. **Owns the platform.** Its OAuth, event model, message/threading format,
   interactive components, and rate limits — none of which Iris should carry.
2. **Speaks only the wire protocol.** It calls the Iris REST channel —
   `POST /v1/session` to start, `POST /v1/session/{sessionId}/message` to continue —
   and needs nothing from any `@irisrun/*` package. (The reference bridge,
   `tests/manual/webhook-bridge.ts`, imports zero Iris packages; a test asserts this.)
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

## Reference bridge

`tests/manual/webhook-bridge.ts` — `makeWebhookBridge({ baseUrl })` — a generic-webhook
bridge that maps `{conversationId, text}` ↔ the REST channel using only `fetch`. Run
the demo:

```sh
npm run demo:bridge   # stands up an in-process channel and drives a 2-turn conversation through the bridge
```

`tests/bridge-reference.test.ts` drives a two-turn conversation end-to-end (token
adoption + rotation across turns; independent conversations → independent sessions) and
asserts the bridge imports nothing from `@irisrun/*`. A Discord or Telegram bridge is
the same shape with a platform adapter in front — **no Iris core changes**.

## When to make it first-party instead

Almost never. Promote a bridge to a first-party channel only when the platform is the
one where the **moat itself** is demonstrated (durable, approval-gated, resumable
sessions) — which is exactly why Slack is first-party and the rest are bridges.
