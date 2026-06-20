# @irisrun/channel-rest

**Durable, replay-safe HTTP sessions.** The in-process REST channel over
`node:http` that owns the two-identifier protocol — a stable `sessionId` plus a
single-use `continuationToken` rotated every committed turn — so a session can be
paused and resumed across processes and a stale or forged token is refused
**loudly** (4xx), never a silent 200.

## What it is

`makeRestChannel` mints the `sessionId`, owns and issues the `continuationToken`,
and streams a turn live over **SSE** *and* a hand-rolled, zero-dependency
**WebSocket** (`ws://…/v1/ws`) — both records and model token deltas. Drop the
`Accept: text/event-stream` header for one buffered JSON reply. ADR-0009; a real
external HTTP deploy is an env-gated manual smoke.

The two-identifier protocol itself — token rotation (only on a committed turn), the
atomic single-use claim, and the loud refusal taxonomy — lives in
**[`@irisrun/channel-core`](../channel-core/README.md)**, the shared channel **port**;
this package is the HTTP/SSE/WS transport over it and passes the shared channel-port
conformance suite (see the normative
**[channel-port spec](../../docs/reference/channel-port-spec.md)**).

## Use it

```sh
iris serve ./image --port 8787     # REST + SSE + WS; add --web for the chat UI
```

See **[docs/04 — Channels](../../docs/04-channels.md)** for the wire protocol and
**[@irisrun/client-sdk](../client-sdk/README.md)** for a typed client.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
