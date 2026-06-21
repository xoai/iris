# Channel-port spec (normative)

The contract every Iris channel satisfies. A channel is a wire in front of a
**durable session**; this spec is what makes channels pluggable and replay-safe by
construction. It is implemented once in `@irisrun/channel-core` and verified by the
importable `@irisrun/channel-conformance` suite that any channel must pass —
`channel-rest`, `channel-mcp`, and `channel-slack` all run it.

> Like the [verifiable-journal spec](./verifiable-journal-spec.md), this is a
> reference document, not a tutorial — start at [Channels](../channels.md).

## The two identifiers

A channel manages exactly two identifiers:

- **`sessionId`** — minted by the channel on START. It names the durable session
  whose state lives in the `StateStore` journal. It is stable for the conversation.
- **`continuationToken`** — owned and issued by the channel; presented by the client
  on the next turn. It is a **single-use, instance-local ordering credential** — NOT
  durable state. The durable session is the journal; the token only sequences turns
  against one channel instance.

## Operations

- **START** — mint a `sessionId`, run the first turn, issue a fresh `continuationToken`.
- **CONTINUE** — present the current token; on success, run a turn and receive the
  **next** token. A held-connection transport (WebSocket) MAY authorize by the
  connection instead of a presented token.

## The token-rotation rule (load-bearing)

A turn produces one of four outcomes: `finished` · `parked` · `contended` · `aborted`.

- **Committed** (`finished`, `parked`): the turn journaled progress → **rotate** the
  token (mint a new one; the old one is now invalid).
- **Non-committed** (`contended` = lease held elsewhere; `aborted` = lease lost
  mid-flight): the turn journaled **nothing** → **keep** the prior token, so the
  client retries the same still-valid single-use credential.
- **START** always issues a fresh token.

Rotating on a non-committed turn would burn a token for a turn that made no progress
— orphaning the session. (This mirrors the durable-scheduler rule that confirms a
wakeup only on a committed outcome.)

## Single-use under concurrency

The token is single-use: the in-flight claim is taken in the **same callback** as the
token check, with no `await` between, so a second concurrent turn presenting the same
valid token is refused — never double-applied. The loser is refused either as
`in-flight` (caught before the winner rotated) or `stale-token` (the winner already
rotated); both uphold single-use.

## Streaming: refuse before the stream opens

A streaming transport (SSE / WebSocket) MUST validate and refuse a continue **before**
it opens the stream — a refusal is a plain loud error (a JSON body, or a close frame),
never a half-open stream that then errors. Use `validateContinue` (and `inFlight`) to
refuse synchronously, then `advance` with no `await` between the check and the claim so
the single-use guarantee holds. A held connection authorizes by the connection itself
and advances with `token:null` (no presented token).

## Refusal taxonomy (all loud)

A continue is refused — never a silent success — for exactly these reasons, each
mapped to the transport's loud error (REST HTTP status, MCP JSON-RPC code, a Slack
ephemeral error):

| Refusal | Meaning | REST | MCP |
| --- | --- | --- | --- |
| `unknown-session` | no such session | 404 | -32001 |
| `missing-token` | no token presented on a continue | 400 | -32002 |
| `stale-token` | token does not match the current one | 409 | -32003 |
| `in-flight` | a turn is already running for this session | 409 | -32004 |

## The port interface

`@irisrun/channel-core` exposes:

- `makeChannelSession({ runTurn, mintSessionId?, mintToken? })` — the driver:
  `start`, `continueTurn` (validate + run + rotate), `validateContinue` / `inFlight` /
  `advance` (primitives for streaming transports that must refuse before opening a
  stream), `currentToken`, `hasSession`, `newSessionId`.
- `ChannelPort<Platform, Reply>` — `normalizeInbound(platformEvent) → Inbound`
  (`start` | `continue` | `ignore`) and `emitOutbound(result) → Reply`.
- `ChannelEvent` / `toOutcomeEvent` — the one streaming-event vocabulary (`record` ·
  `delta` · `outcome` · `error`); `record`/`delta` are streaming-only and absent on a
  buffered transport.

## Conformance

`@irisrun/channel-conformance` is the importable definition of done: supply a fixture
that drives your transport and `register(runChannelPortConformance(fixture), test)`. It
certifies that a channel mints on START; rotates **only** on a committed continue; keeps
the prior token on `contended`/`aborted`; refuses stale/missing/unknown/in-flight loudly
(and **only** those four); enforces single-use under concurrency (including **replayed**
and **cross-session** tokens); and — via the opt-in `holdConnection` fixture — the
`token:null` hold-connection advance path. Passing it is the definition of a first-class
Iris channel.

**Scope.** Conformance certifies the two-identifier protocol ONLY. Signature
verification (e.g. Slack), approval / HITL logic, and frame encoding (SSE / WebSocket
framing) are the channel's own concern — test those separately.

---

Back to the **[Channels chapter](../channels.md)** · the **[bridge pattern](./bridge-pattern.md)** · the **[project README](../../README.md)**.
