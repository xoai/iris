// T1 — the agent exposed AS an MCP server (MCP is dual-use). A
// minimal-but-faithful MCP server over JSON-RPC 2.0: initialize / tools/list /
// tools/call {start,message}. It speaks the SAME two-identifier protocol as the
// REST channel (channel MINTS sessionId, ISSUES + ROTATES the continuationToken,
// token is ATOMICALLY single-use) and surfaces every failure as a LOUD JSON-RPC
// error — never a silent OK. `handle(req)` is the testable core (no real stdio).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Program, Json, JournalRecord } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeMcpChannel, type TurnInputs } from "@irisrun/channel-mcp";
import type { HostAdapter } from "@irisrun/host";
import { TestClock } from "./lib/mem-store.ts";

type ChState = { turns: number };

// trivial, effect-free finishing program — each turn finishes, bumping a counter
const program: Program<ChState> = {
  initial: { turns: 0 },
  reducer(state: ChState, record: JournalRecord): ChState {
    if (record.kind === "marker" && (record.payload as { marker?: string }).marker === "finish") {
      return { turns: state.turns + 1 };
    }
    return state;
  },
  step(state: ChState) {
    return { type: "finish", output: { turn: state.turns } } as const;
  },
};

function makeChannel() {
  const adapter: HostAdapter = {
    name: "serverless-fs",
    capabilities: { long_running: false },
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
  };
  const makeTurnInputs = (): TurnInputs<ChState> => ({
    program,
    performers: {},
    clock: new TestClock(1),
    defDigest: "img-digest",
  });
  return makeMcpChannel<ChState>({ adapter, makeTurnInputs });
}

const rpc = (id: number | string, method: string, params?: Json) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

// parse the payload the channel returns inside the MCP tools/call content block
interface TurnPayload {
  sessionId: string;
  continuationToken: string;
  status: string;
  output?: Json;
  wait?: Json;
}
function callPayload(resp: { result?: { content?: Array<{ text?: string }> } }): TurnPayload {
  const text = resp.result?.content?.[0]?.text;
  assert.ok(typeof text === "string", "tools/call result must carry a text content block");
  return JSON.parse(text as string) as TurnPayload;
}

test("T1 MCP: initialize advertises tool capability; tools/list advertises start + message", async () => {
  const ch = makeChannel();
  const init = (await ch.handle(rpc(1, "initialize"))) as { result?: { capabilities?: { tools?: unknown } } };
  assert.ok(init.result?.capabilities?.tools !== undefined, "initialize advertises tools capability");

  const list = (await ch.handle(rpc(2, "tools/list"))) as { result?: { tools?: Array<{ name: string }> } };
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, ["message", "start"]);
});

test("T1 MCP: tools/call start ISSUES {sessionId, continuationToken}; message round-trips a NEW token", async () => {
  const ch = makeChannel();
  const start = await ch.handle(rpc(1, "tools/call", { name: "start", arguments: {} }));
  const s = callPayload(start as never);
  assert.equal(typeof s.sessionId, "string");
  assert.equal(typeof s.continuationToken, "string");
  assert.equal(s.status, "finished");
  assert.deepEqual(s.output, { turn: 0 });

  const cont = await ch.handle(
    rpc(2, "tools/call", { name: "message", arguments: { sessionId: s.sessionId, continuationToken: s.continuationToken } }),
  );
  const c = callPayload(cont as never);
  assert.equal(c.status, "finished");
  assert.deepEqual(c.output, { turn: 1 }, "the session advanced a turn");
  assert.notEqual(c.continuationToken, s.continuationToken, "the channel rotated the token");
});

test("T1 MCP: a STALE token is a loud JSON-RPC error", async () => {
  const ch = makeChannel();
  const s = callPayload((await ch.handle(rpc(1, "tools/call", { name: "start", arguments: {} }))) as never);
  // burn token1
  await ch.handle(rpc(2, "tools/call", { name: "message", arguments: { sessionId: s.sessionId, continuationToken: s.continuationToken } }));
  // re-present the now-stale token1
  const stale = (await ch.handle(
    rpc(3, "tools/call", { name: "message", arguments: { sessionId: s.sessionId, continuationToken: s.continuationToken } }),
  )) as { error?: { message?: string }; result?: unknown };
  assert.equal(stale.result, undefined, "no silent OK on a stale token");
  assert.match(String(stale.error?.message), /stale|invalid/i);
});

test("T1 MCP: a MISSING token and an UNKNOWN session are loud JSON-RPC errors", async () => {
  const ch = makeChannel();
  const s = callPayload((await ch.handle(rpc(1, "tools/call", { name: "start", arguments: {} }))) as never);
  const missing = (await ch.handle(
    rpc(2, "tools/call", { name: "message", arguments: { sessionId: s.sessionId } }),
  )) as { error?: { message?: string } };
  assert.match(String(missing.error?.message), /missing continuationToken/i);

  const unknown = (await ch.handle(
    rpc(3, "tools/call", { name: "message", arguments: { sessionId: "nope", continuationToken: "x" } }),
  )) as { error?: { message?: string } };
  assert.match(String(unknown.error?.message), /unknown session/i);
});

test("T1 MCP: protocol errors are loud (unknown method → -32601; unknown tool → -32602)", async () => {
  const ch = makeChannel();
  const m = (await ch.handle(rpc(1, "no/suchMethod"))) as { error?: { code?: number } };
  assert.equal(m.error?.code, -32601);
  const t = (await ch.handle(rpc(2, "tools/call", { name: "bogus", arguments: {} }))) as { error?: { code?: number } };
  assert.equal(t.error?.code, -32602);
});

test("T1 MCP: the continuationToken is SINGLE-USE under concurrency (two same-token messages → one ok, one error)", async () => {
  const ch = makeChannel();
  const s = callPayload((await ch.handle(rpc(1, "tools/call", { name: "start", arguments: {} }))) as never);
  const [a, b] = (await Promise.all([
    ch.handle(rpc(2, "tools/call", { name: "message", arguments: { sessionId: s.sessionId, continuationToken: s.continuationToken } })),
    ch.handle(rpc(3, "tools/call", { name: "message", arguments: { sessionId: s.sessionId, continuationToken: s.continuationToken } })),
  ])) as Array<{ result?: unknown; error?: unknown }>;
  const oks = [a, b].filter((r) => r.result !== undefined).length;
  const errs = [a, b].filter((r) => r.error !== undefined).length;
  assert.equal(oks, 1, `exactly one concurrent same-token message wins (got ${oks})`);
  assert.equal(errs, 1, `the other is refused (got ${errs})`);
});
