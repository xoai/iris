# @irisrun/channel-mcp

**Durable, replay-safe sessions — the agent exposed *as* an MCP server.** A minimal,
faithful Model Context Protocol server over JSON-RPC 2.0 (stdio): `initialize` /
`tools/list` / `tools/call {start, message}`. It speaks the same two-identifier
protocol as every Iris channel — a stable `sessionId` plus a single-use
`continuationToken` rotated every committed turn — and surfaces every failure as a
**loud** JSON-RPC error, never a silent OK.

## What it is

`makeMcpChannel(...)` exposes `handle(req)` (the testable core) and `serve(in, out)`
(newline-delimited JSON-RPC over stdin/stdout). It is **built on
[`@irisrun/channel-core`](../channel-core/README.md)** — the shared channel **port** —
so the token discipline (mint, rotate-only-on-a-committed-turn, atomic single-use) and
the refusal taxonomy live in one place, and this transport just maps refusals to the
JSON-RPC error range (`-32001` unknown session · `-32002` missing token · `-32003`
stale token · `-32004` in-flight). It passes the same channel-port conformance suite
`@irisrun/channel-rest` does — "channels behind one port" is an executed guarantee.

Host-side (`node:crypto`); the pure core stays unchanged. ADR-0009 (MCP is dual-use); a
real MCP stdio client is an env-gated manual smoke.

## Use it

A client calls the `start` tool to begin a session and `message` to continue it,
presenting the issued `continuationToken` each turn.

See **[docs/04 — Channels](../../docs/04-channels.md)** and the normative
**[channel-port spec](../../docs/channel-port-spec.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
