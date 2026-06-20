# 04 — Channels

A channel puts a human in front of a **durable session** — one that survives a tab
close, a process restart, even a host migration, and resumes mid-conversation from
the same journal. `iris chat` is the terminal channel; to reach a human in a
browser, serve the same image over HTTP — buffered REST plus live token streaming
over SSE or WebSocket — with a real chat UI in front of it.

## Serve it

```sh
iris serve ./image --port 8787 --web
# → iris serve: listening on http://127.0.0.1:8787 (model=echo, web=on)
```

`iris serve` defaults to the **no-key echo model** so it streams immediately; pass
`--model anthropic` (or `--model openai`) with the matching API key for the real
provider. See [06 — Models & providers](./06-providers.md).

`--web` serves a minimal chat UI (from `@irisrun/channel-web`) at `GET /`. Open
`http://127.0.0.1:8787/` in a browser and talk to the agent.

## The protocol

The HTTP API is a two-identifier protocol: the channel **mints** the `sessionId`
and **owns and rotates** a single-use `continuationToken` every committed turn.

```sh
# Start a session, streaming the turn as Server-Sent Events:
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:8787/v1/session
# event: delta    data: {"type":"delta","text":"echo:"}      ← one event per model token
# event: outcome  data: {"type":"outcome","sessionId":"…","status":"parked","continuationToken":"…"}

# Continue the SAME session — present the rotated token; the path carries the sessionId:
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"continuationToken":"<token>","messages":[{"role":"user","content":"more"}]}' \
  http://127.0.0.1:8787/v1/session/<sessionId>/message
```

Drop `Accept: text/event-stream` for a single buffered JSON reply. A WebSocket
client can hold one connection for the whole conversation at
`ws://127.0.0.1:8787/v1/ws`. A stale or missing token is refused **loudly** (4xx),
never a silent 200.

## The client SDK

You rarely want to hand-roll that protocol. `@irisrun/client-sdk` is a thin, isomorphic
client (Node ≥ 24 and the browser; zero runtime deps) that mirrors the channel's
discipline exactly — it adopts the rotated `continuationToken` the server returns
and presents it on the next turn.

- `new IrisClient({ baseUrl })` — start a fresh session on the next send.
- `new IrisClient({ baseUrl, handle })` — **resume** an existing session from a
  `SessionHandle` (`{ sessionId, continuationToken }`).
- send a turn buffered, or stream deltas via callbacks.

Because the SDK holds only a `SessionHandle` — not a live connection — a browser
tab can close and reopen, rebuild the client from the saved handle, and resume the
**same** durable session. (Within one running `iris serve` process the channel owns
the token in memory; surviving a *server* restart is what the edge deploy in the
next chapter is for.)

## The channel port

REST, MCP, and Slack are different wires in front of the **same** durable session.
What they share — mint the `sessionId`, own and **rotate a single-use continuation
token**, refuse a stale/missing/unknown/in-flight turn **loudly** — is factored into
one port, `@irisrun/channel-core`, the way `StateStore` is the store port. A channel
is then just: normalize the platform's inbound event → drive the shared session →
emit the platform's reply.

The rule that makes this replay-safe by construction: the token rotates **only on a
committed turn** (`finished`/`parked`). A turn that journaled nothing — `contended`
(the lease was held elsewhere) or `aborted` (the lease was lost mid-flight) — **keeps
the prior token**, so the client safely retries the same single-use credential. The
in-flight claim is atomic, so a concurrent replay of a token is refused, never
double-applied.

Because the contract is one shared driver, it is verified by **one conformance suite
any channel must pass** — `channel-rest` and `channel-mcp` both run it. A new channel
that passes the suite is durable and replay-safe by construction. The normative
contract is [the channel-port spec](./channel-port-spec.md).

**Next → [05 — Deploy](./05-deploy.md)**
