// channel-mcp runs the shared channel-port conformance suite (roadmap v0.2 §10, plan
// T10.4) — "two channels pass the same port conformance suite", MCP half. Drives the
// REAL handle() JSON-RPC surface; a makeFlippableStore lets the suite force
// contended/aborted. Until §10's refactor, MCP rotates on contended/aborted — those
// two assertions are the load-bearing red→green proof of the unified rule.
import type { Program, Json, JournalRecord } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeMcpChannel, type TurnInputs } from "@irisrun/channel-mcp";
import type { HostAdapter } from "@irisrun/host";
import { TestClock } from "./lib/mem-store.ts";
import { makeFlippableStore } from "./lib/flaky-store.ts";
import { runChannelPortConformance, type ChannelOps, type Refusal } from "./lib/channel-port-conformance.ts";

type ChState = { turns: number };
const program: Program<ChState> = {
  initial: { turns: 0 },
  reducer(state, record: JournalRecord) {
    if (record.kind === "marker" && (record.payload as { marker?: string }).marker === "finish") {
      return { turns: state.turns + 1 };
    }
    return state;
  },
  step(state) {
    return { type: "finish", output: { turn: state.turns } } as const;
  },
};

const RPC_REFUSAL: Record<number, Refusal> = {
  [-32001]: "unknown-session",
  [-32002]: "missing-token",
  [-32003]: "stale-token",
  [-32004]: "in-flight",
};

// The MCP tool result wraps the payload as content:[{type:"text",text:JSON.stringify(payload)}].
function parseCallResult(resp: unknown): Record<string, Json> {
  const r = resp as { result?: { content?: Array<{ text?: string }> } };
  const text = r.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, Json>;
}

runChannelPortConformance({
  name: "channel-mcp",
  async create(): Promise<ChannelOps> {
    const { store, setNext } = makeFlippableStore(new MemoryStateStore());
    const adapter: HostAdapter = {
      name: "conformance-mcp",
      capabilities: { long_running: false },
      store,
      scheduler: new MemoryScheduler(),
    };
    const makeTurnInputs = (): TurnInputs<ChState> => ({
      program,
      performers: {},
      clock: new TestClock(1),
      defDigest: "img-digest",
    });
    const ch = makeMcpChannel<ChState>({ adapter, makeTurnInputs });
    let id = 0;
    const rpc = (method: string, params: Json) => ({ jsonrpc: "2.0" as const, id: ++id, method, params });
    return {
      async start() {
        const resp = await ch.handle(rpc("tools/call", { name: "start", arguments: {} }));
        const p = parseCallResult(resp);
        return { sessionId: p.sessionId as string, token: p.continuationToken as string };
      },
      setNext,
      async continueTurn(sessionId, token) {
        const args: Record<string, Json> = { sessionId };
        if (token !== null) args.continuationToken = token;
        const resp = (await ch.handle(rpc("tools/call", { name: "message", arguments: args }))) as {
          result?: unknown;
          error?: { code?: number };
        };
        if (resp.result !== undefined) {
          const p = parseCallResult(resp);
          return { ok: true, token: p.continuationToken as string, status: p.status as string };
        }
        return { ok: false, refusal: RPC_REFUSAL[resp.error?.code ?? 0] ?? "stale-token" };
      },
      close: async () => {},
    };
  },
});
