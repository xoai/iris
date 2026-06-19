# 04 — Channels

`iris chat` is a terminal. To reach a human in a browser, serve the same image over
HTTP — buffered REST plus live token streaming over SSE or WebSocket — and put a
real chat UI in front of it.

## Serve it

```sh
iris serve ./image --port 8787 --web
# → iris serve: listening on http://127.0.0.1:8787 (model=echo, web=on)
```

`iris serve` defaults to the **no-key echo model** so it streams immediately; pass
`--model anthropic` (or `--model openai`) with the matching API key for the real
provider. See [06 — Models & providers](./06-providers.md).

`--web` serves a minimal chat UI (from `@iris/channel-web`) at `GET /`. Open
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

You rarely want to hand-roll that protocol. `@iris/client-sdk` is a thin, isomorphic
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

**Next → [05 — Deploy](./05-deploy.md)**
