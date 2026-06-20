# @irisrun/tools

**One tool boundary, one identity, four transports — all over the same
journaled effect.** A `ToolContract` declares the model-visible surface; the
uniform `ToolInvoker` dispatches it to in-process, subprocess, MCP-stdio, or
gRPC, and the real `tool_call` performer answers the kernel's effect across that
boundary — so a tool can move localities without changing its identity or
touching the engine.

## What it is

`ToolContract` + `contractDigest`: the digest is `sha256` over the
*model-perceived* surface only (`name` / `description` / `inputSchema`) —
`transport` / `location` / `retrySafe` are deliberately excluded, so the same
logical tool keeps one identity across every locality. `makeToolRegistry` does a
build-time collision check on names. The uniform `ToolInvoker` (`makeToolInvoker`)
is one `invoke(...)` interface over a `TransportTable`, dispatched on
`contract.transport`; a transport that is not configured fails loudly as
`{ok:false, code:"no_transport"}` — never a silent no-op. Four real transports
ship: `makeInProcessTransport`, `makeSubprocessTransport`, `makeMcpStdioTransport`,
and `makeGrpcTransport` (gRPC-over-http2 with a JSON codec + framing helpers).
`makeToolPerformer` is the real `tool_call` performer: it resolves the contract
by name (unknown name → loud `{ok:false}`), invokes it through the boundary, and
forwards the engine's `idempotencyKey` on a recovery re-perform so a retry-safe
tool can dedupe. The engine's effect / recovery / replay machinery is reused
verbatim — `engine.ts` is byte-untouched. Host-side; depends on `@irisrun/core`
only, zero external deps.

## Use it

Library-only (no CLI). Build a registry from your `ToolContract`s, wire a
`makeToolInvoker` with the transports you need, and register `makeToolPerformer`
as the host's `tool_call` performer.

See **[docs/Tools](../../docs/tools.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
