# @irisrun/channel-conformance

**The importable certification suite for an Iris channel.** Every channel — REST, MCP,
Slack, or your own — must uphold the **two-identifier protocol**: mint a `sessionId`,
own and rotate a **single-use** continuation token (committed-only rotation), claim an
atomic per-session in-flight, and refuse loudly with one of four reasons. This package
turns that contract into a runnable suite: pass it and your channel is replay-safe by
construction.

## Use it

Runner-agnostic — it returns cases and never imports a test runner. Provide a
`ChannelPortFixture` that drives your transport; `register` wires the cases into
`node:test` (or any runner):

```ts
import { test } from "node:test";
import { runChannelPortConformance, register, type ChannelOps } from "@irisrun/channel-conformance";

register(runChannelPortConformance({
  name: "my-channel",
  async create(): Promise<ChannelOps> {
    // stand up your channel; return start() / setNext() / continueTurn() / close()
  },
}), test);
```

The suite covers START/token issuance, committed-only rotation, the four refusals
(`unknown-session` / `missing-token` / `stale-token` / `in-flight`), single-use under
concurrency, token replay, cross-session tokens, malformed input, and the refusal
taxonomy. A **hold-connection** transport (WebSocket / gRPC, which authorizes by the
connection rather than a presented token) supplies the opt-in `holdConnection` fixture
to certify the `token:null` advance path.

## What it does NOT cover

Conformance certifies the two-identifier protocol only. Signature verification,
approval/HITL logic, and frame encoding (SSE/WS framing) are the channel's own concern
— test them separately. See `docs/reference/channel-port-spec.md` and
`docs/contributing/adding-a-channel.md`.
