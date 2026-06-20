# @irisrun/channel-core

**Own, portable, verifiable state — in front of a human, over any channel.**
The narrow channel **port**: the contract every Iris channel implements so durable,
resumable, approval-gated sessions are pluggable and **replay-safe by construction**.

## What it is

`channel-rest`, `channel-mcp`, and `channel-slack` all speak the same two-identifier
protocol. This package is that protocol, factored into one driver:

- `makeChannelSession({ runTurn })` — mints the `sessionId`, owns and **rotates a
  single-use continuation token**, and enforces the rotation rule in one place:
  rotate **only on a committed turn** (`finished`/`parked`); a non-committed turn
  (`contended`/`aborted`) journaled nothing, so it **keeps the prior token**. The
  in-flight claim is atomic (taken in the same callback as the token check), so a
  concurrent replay of a token is refused, not double-applied.
- `start` / `continueTurn` — the high-level API; `validateContinue` / `inFlight` /
  `advance` — primitives a streaming transport uses to refuse loudly *before* opening
  a stream. Refusals are a typed taxonomy: `unknown-session` · `missing-token` ·
  `stale-token` · `in-flight`.
- `ChannelPort<Platform, Reply>` — the `normalizeInbound` / `emitOutbound` contract a
  platform adapter implements. A transport reduces to: normalize → drive the session
  → emit.
- `ChannelEvent` / `toOutcomeEvent` — the one streaming-event vocabulary (`record` ·
  `delta` · `outcome` · `error`), shared so SSE, WebSocket, and any future transport
  agree field-for-field.

The proof that channels are interchangeable is a single shared **conformance suite**
(`tests/lib/channel-port-conformance.ts`) that channel-rest and channel-mcp both pass —
"two channels behind one port" is a literal, executed guarantee.

The continuation token is an instance-local ordering credential; the **durable**
session lives in the StateStore journal. See `docs/channel-port-spec.md`.

---

Part of Iris — own, portable, verifiable state.
