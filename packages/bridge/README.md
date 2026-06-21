# @irisrun/bridge

**Reach any platform from Iris with the wire protocol handled for you.** A *bridge*
is an external process that maps a chat platform (Telegram, Discord, Teams, a
webhook) to a durable Iris session over the REST channel — minting a session,
presenting and **adopting the rotated continuation token** every turn. This package
is the optional Node ergonomics for that; it is **zero-dep and imports nothing from
Iris** (it only speaks HTTP), so a bridge can equally be written in any language
with no SDK at all.

## Build a bridge

```ts
import { makePlatformBridge, type PlatformAdapter } from "@irisrun/bridge";

// an adapter is the only platform-specific code: verify auth, parse inbound, format reply
const myAdapter: PlatformAdapter<MyReply> = {
  name: "my-platform",
  verify(headers, rawBody) { /* signature / secret check — loud false, never throw */ return true; },
  parse(rawBody) { /* → { kind: "message", conversationId, text } | handshake | ignore */ },
  formatReply(reply) { /* → your platform's HTTP-response body */ },
};

const bridge = makePlatformBridge(myAdapter, { baseUrl: "https://my-iris-host" });
// in your webhook handler:
const { status, body } = await bridge.handle(req.headers, rawBody); // verify-first: 401 before any turn
```

For a raw conversation map without the adapter layer, use `makeBridgeSession({ baseUrl })`
and call `onMessage({ conversationId, text })`. The discord/telegram/teams **reference
adapters** (`tests/examples/bridges/`) are the worked examples to copy and adapt.

## Certify it

```ts
import { test } from "node:test";
import { runBridgeConformance, runAdapterConformance, register } from "@irisrun/bridge";

register(runBridgeConformance(), test);                 // token adoption/rotation, independent convos, clean restart
register(runAdapterConformance(myAdapter, vectors), test); // verify accepts/rejects, parse maps, verify-first
```

`runBridgeConformance` runs against an in-package fake channel (no server needed).
See `docs/reference/bridge-pattern.md` for the full pattern.
