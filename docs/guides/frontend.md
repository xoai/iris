# Frontend & the client SDK

Putting an agent in front of users is two small pieces, not a framework. One
serves a chat page; the other is a client you embed. Both hold the **same** thing —
a `{sessionId, continuationToken}` handle — so a tab close, a reload, or a fresh
process picks the durable session back up mid-conversation. Neither holds a live
connection.

This is the consumer's view of the [channels](../channels.md) protocol: `iris serve`
mints the `sessionId` and rotates a single-use `continuationToken` every committed
turn, and these two pieces *adopt* that token rather than minting their own.

## The zero-dep web chat UI

You already met it in passing: `iris serve --web` serves a minimal chat page at
`GET /`.

```sh
iris serve ./image --port 8787 --web
# → open http://127.0.0.1:8787/ and talk to the agent
```

That page is `@irisrun/channel-web`. On the host side it's tiny: `makeWebHandler`
returns a pre-POST `GET` hook that serves exactly two static assets — `index.html`
and `iris-web.js` (the `webAssets` map) — and returns `false` for everything else,
so `/v1/*` POST and the WebSocket upgrade pass straight through to the REST channel.
No bundler, no framework, no runtime deps.

The browser shell (`iris-web.js`) is where the durability shows up. It persists the
handle to `localStorage` under the key `iris.session`:

- on load it reads the saved `{sessionId, continuationToken}` and resumes that
  session — the banner reads `resumed session …`;
- after every committed turn it saves the **rotated** token the `outcome` event
  carries;
- close the tab, reopen it, and the same durable session continues — no re-start.

The shell streams over SSE and renders deltas token-by-token, mirroring the SDK's
own wire parsing (it can't `import` the SDK — there's no bundler — so it reuses the
logic by hand). When a saved token has gone stale — a `404` or `409`, e.g. after a
server restart — it **clears the handle and starts fresh**, never throws. The **New**
button does the same on demand.

One caveat, the same one [channels](../channels.md) names: resume works **while the
server is up**. The running `iris serve` channel owns the token in an in-memory map;
surviving a *server* restart or host migration is the edge deploy's job, not the
browser's.

## The isomorphic client SDK

When you're building your own frontend — not using the canned page — reach for
`@irisrun/client-sdk`. It's a thin, **isomorphic** client: the same code runs in the
browser and in Node ≥ 24, with **zero runtime deps** (it uses only the global
`fetch`, `TextDecoder`, and `ReadableStream`). It holds a `SessionHandle`, not a
connection, and mirrors the channel's token discipline exactly — adopt the rotated
token, present it next turn.

### Start a session

```ts
import { IrisClient } from "@irisrun/client-sdk";

const client = new IrisClient({ baseUrl: "http://127.0.0.1:8787" });

const r = await client.start({ messages: [{ role: "user", content: "hello" }] });
// r.status   → "finished" | "parked" | "contended" | "aborted"
// r.output   → the agent's structured output (when finished)
// client.handle → { sessionId, continuationToken }  ← save this
```

`new IrisClient({ baseUrl })` starts fresh on the first send. `start()` POSTs to
`/v1/session`; `client.handle` is `null` until it returns, then holds the minted
`{sessionId, continuationToken}`.

### Continue it

```ts
const r2 = await client.send({ messages: [{ role: "user", content: "more" }] });
// the SDK presents the held token and adopts the rotated one it gets back
```

`send()` POSTs to `/v1/session/<id>/message` with the current token. Calling `send()`
before any session exists rejects **loudly** with an `IrisError` (code `no-session`) —
call `start()` first, or construct the client with a handle.

### Resume across a reload

Because the client holds **only** the handle, you can throw the object away and
rebuild it later from a saved handle — the same trick the web shell does with
`localStorage`:

```ts
import { IrisClient, type SessionHandle } from "@irisrun/client-sdk";

const handle: SessionHandle = load(); // { sessionId, continuationToken }
const client = new IrisClient({ baseUrl, handle });
await client.send({ messages: [{ role: "user", content: "still here?" }] });
// continues the SAME session — same sessionId, no re-start
```

(As with the web UI, resume binds to the **same running** `iris serve` channel that
owns the token in memory.)

### Stream the reply

Pass `stream: true` with callbacks to get deltas as they arrive over SSE. The
returned `TurnResult.text` is the concatenation of every `delta` — it equals the
final reply:

```ts
const r = await client.send(
  { messages: [{ role: "user", content: "tell me a story" }] },
  {
    stream: true,
    callbacks: {
      onDelta: (t) => process.stdout.write(t), // one event per model token
      onRecord: (rec) => {/* the committed journal record timeline */},
      onError: (msg) => {/* a mid-stream error event */},
    },
  },
);
console.log(r.text); // === the joined deltas
```

Drop `stream` (or set it `false`) for a single buffered `TurnResult` — same shape,
no callbacks.

### Errors are loud

The SDK never silently resolves on a failure. A non-2xx response, a mid-stream
`error` event, or a transport fault all reject with an `IrisError` — a structured
error carrying a `code` and (for HTTP failures) the `status`. A stale or missing
continuation token comes back as `IrisError` with `status: 409` — the same loud
refusal the channel protocol guarantees, surfaced to your `catch`.

The SDK also exports two pure, IO-free helpers it uses internally — `parseSseFrames`
(parse complete SSE frames out of a buffer, keeping the trailing partial) and
`decideStartOrResume` (a `null` handle → `"start"`, a handle → `"resume"`) — handy if
you're reimplementing the wire yourself.

> **WS is reserved.** `transport: "ws"` throws `IrisError` (`ws-unsupported`) today;
> the streaming path is SSE-only, which is also all the edge/web deploys offer.

## Where this sits

These are the consumer-facing edges of the same durable session everything else in
Iris drives. The protocol they speak — the two identifiers, the loud refusal, the
rotate-only-on-commit rule — is the channel port, normatively specified in
[the channel-port spec](../reference/channel-port-spec.md); the serve/SSE/web context
lives in [Channels](../channels.md).
