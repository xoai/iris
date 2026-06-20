# @irisrun/client-sdk

**A portable client for durable, resumable sessions.** A thin, isomorphic
(browser + Node ≥ 24) client over the `iris serve` protocol that holds only a
`{ sessionId, continuationToken }` handle — *not* a live connection — so a reload
or a brand-new process can rebuild the client from the saved handle and resume the
**same** session.

## What it is

`IrisClient` mirrors the channel's two-identifier discipline exactly: it adopts
the rotated `continuationToken` the server returns and presents it on the next
turn. Sends are buffered or streamed over **SSE** via callbacks. Zero runtime
dependencies — only global `fetch` / `TextDecoder` / `ReadableStream` — and it
defines its own local `StreamEvent` wire union (it does *not* import
`@irisrun/channel-rest`, which would pull in `node:http`). The WebSocket transport
is **reserved** (held-connection model) and throws loudly until implemented — SSE
and buffered today.

## Use it

```ts
import { IrisClient } from "@irisrun/client-sdk";

const client  = new IrisClient({ baseUrl });          // start a fresh session
const resumed = new IrisClient({ baseUrl, handle });  // resume from a SessionHandle
```

See **[docs/04 — Channels](../../docs/04-channels.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
