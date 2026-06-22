# Channels

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
provider. See [Models & providers](./providers.md).

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
one port, `@irisrun/channel-core`, the way `StateStore` (a host's durable byte store) is the store port. A channel
is then just: normalize the platform's inbound event → drive the shared session →
emit the platform's reply.

The rule that makes this replay-safe by construction: the token rotates **only on a
committed turn** (`finished`/`parked`). A turn that journaled nothing — `contended`
(the lease was held elsewhere) or `aborted` (the lease was lost mid-flight) — **keeps
the prior token**, so the client safely retries the same single-use credential. The
in-flight claim is atomic, so a concurrent replay of a token is refused, never
double-applied.

Because the contract is one shared driver, it is verified by **one conformance suite
any channel must pass** — `channel-rest`, `channel-mcp`, and `channel-slack` all run it. A new channel
that passes the suite is durable and replay-safe by construction. The normative
contract is [the channel-port spec](./reference/channel-port-spec.md).

## Slack — durable human-in-the-loop

Chat is where durable, approval-gated sessions matter most. `@irisrun/channel-slack`
is built on the port to demonstrate the one thing only Iris does: **a Slack approval
that pauses for hours, survives a redeploy, and resumes the same session
byte-identically.**

The flow: a slash command starts a durable session; when the agent gates an action
for human approval, the channel posts **Approve / Deny** buttons; a click submits the
decision and resumes the session. What makes it survive a redeploy is *where* the
state lives:

- the **durable session** is the `StateStore` journal — the parked wait for the approval
  signal (a journaled `signal_recv`) means any instance can resume it from the store;
- the **approval context** (`{sessionId, callId, name}`) rides the **signed Slack
  button value**, not server memory, so a fresh instance with an empty map can still
  reconstruct the click;
- the **identity** comes from the click's authenticated Slack user.

So an approval can sit for days, the service can redeploy, and the Approve still
resumes the exact same session. This guarantee is proven in-env against a real store
across a simulated redeploy (`tests/channel-slack-durable.test.ts`), including a
byte-identical comparison to a no-redeploy control.

Every request is verified first (HMAC-SHA256, constant-time, 5-minute replay window);
an unverified body is never processed. Zero runtime deps — `node:crypto` plus built-in
`fetch` for outbound.

**Operator setup** (the public-workspace step): create a Slack app, set its signing
secret and bot token as env, and point the slash command + interactivity request URLs
at your `iris`-served endpoint. The durability *guarantee* is the in-env test above;
the live workspace is configuration, not new code.

> As everywhere, "resumes byte-identically" is faithful **record-replay** of the
> session's journal — not a claim the model is deterministic.

## Other platforms — bridges, not packages

Discord, Telegram, Teams, and the rest are reached by a **bridge**: an external
process that speaks the REST channel protocol, runnable in any language, needing **no
Iris core changes**. Matching another framework's channel list is parity; one channel
that demonstrates the moat (Slack, above) beats five that reach it. The
[bridge pattern](./reference/bridge-pattern.md) is the normative contract, with a fetch-only
reference bridge (`npm run demo:bridge`).

### Plug & play: `iris bridge <module>`

Six reference bridge adapters ship ready to run, each with real per-platform auth — and
they're **pluggable by module specifier**, the channel analog of `--store`:

| Platform | Adapter (copy & adapt) | Env config |
|---|---|---|
| Discord | `tests/examples/bridges/discord.ts` | `DISCORD_PUBLIC_KEY` |
| Telegram | `tests/examples/bridges/telegram.ts` | `TELEGRAM_SECRET_TOKEN` |
| Teams | `tests/examples/bridges/teams.ts` | `TEAMS_SHARED_SECRET` |
| WhatsApp | `tests/examples/bridges/whatsapp.ts` | `WHATSAPP_APP_SECRET` |
| Twilio | `tests/examples/bridges/twilio.ts` | `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` |
| Google Chat | `tests/examples/bridges/googlechat.ts` | `GOOGLE_CHAT_TOKEN` |

```sh
iris serve ./image --port 8787 &     # 1) the durable Iris channel
TELEGRAM_SECRET_TOKEN=<your-secret> \
  iris bridge ./tests/examples/bridges/telegram.ts --base-url http://127.0.0.1:8787   # 2) the bridge
# then point the platform's webhook at the bridge (default http://127.0.0.1:8788)
```

A bridge module just exports `openBridge(opts)` (an `@irisrun/bridge` `OpenBridge`); the
CLI dynamic-imports it, so it adds **no dependency** to Iris. Your own platform is the
same shape — write the three-function adapter (`verify` / `parse` / `formatReply`),
certify it with `runAdapterConformance`, run it with `iris bridge ./my-bridge.ts`. Full
recipe + the "run a bridge forklessly" section: [bridge pattern](./reference/bridge-pattern.md).

**Next → [Deploy](./deploy.md)**
