// makeMcpChannel (ADR-0009, MCP is dual-use): the agent exposed AS an MCP server
// over JSON-RPC 2.0. `handle(req)` is the testable core; `serve(in,out)` frames
// newline-delimited JSON-RPC over a stream (stdin/stdout in production). It speaks
// the SAME two-identifier protocol as channel-rest — the channel MINTS the
// sessionId and OWNS/ISSUES the continuationToken (rotated per committed turn,
// ATOMICALLY single-use via a per-session in-flight claim taken with no `await`
// between the token check and the claim) — and surfaces every failure as a LOUD
// JSON-RPC error, never a silent OK. Host-side (node:crypto); core stays pure.
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { runTurnOn, type HostAdapter } from "@iris/host";
import type { Program, PerformerRegistry, LogicalClock, Json, TurnOutcome } from "@iris/core";

export interface TurnInputs<S extends Json> {
  program: Program<S>;
  performers: PerformerRegistry;
  clock: LogicalClock;
  defDigest: string;
  snapshotThreshold?: number;
  holderId?: string;
}

export interface McpChannelOptions<S extends Json> {
  adapter: HostAdapter;
  makeTurnInputs: (sessionId: string, args: Json) => TurnInputs<S>;
  mintSessionId?: () => string;
  mintToken?: () => string;
  serverInfo?: { name: string; version: string };
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Json;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: Json }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

export interface McpChannel {
  handle(req: unknown): Promise<JsonRpcResponse>;
  serve(input: Readable, output: Writable): void;
}

// JSON-RPC + MCP error codes. Protocol errors use the standard codes; app errors
// (token/session) use the implementation-defined -32000 range — all LOUD.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNKNOWN_SESSION = -32001;
const MISSING_TOKEN = -32002;
const STALE_TOKEN = -32003;
const IN_FLIGHT = -32004;

const PROTOCOL_VERSION = "2024-11-05";

const START_TOOL = {
  name: "start",
  description: "Begin a session: run the first turn; returns {sessionId, continuationToken, status, output?}.",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};
const MESSAGE_TOOL = {
  name: "message",
  description: "Continue a session: present the issued continuationToken; returns a NEW token + status.",
  inputSchema: {
    type: "object",
    properties: { sessionId: { type: "string" }, continuationToken: { type: "string" } },
    required: ["sessionId", "continuationToken"],
  },
};

export function makeMcpChannel<S extends Json>(opts: McpChannelOptions<S>): McpChannel {
  const mintSessionId = opts.mintSessionId ?? (() => randomUUID());
  const mintToken = opts.mintToken ?? (() => randomUUID());
  const serverInfo = opts.serverInfo ?? { name: "iris", version: "0.0.0" };
  const tokens = new Map<string, string>(); // the channel OWNS the current token per session
  const inFlight = new Set<string>(); // single-use guard under concurrency (see channel-rest)

  const ok = (id: number | string | null, result: Json): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const err = (id: number | string | null, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  const toolResult = (payload: Json): Json => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

  const runOne = async (sessionId: string, args: Json): Promise<TurnOutcome<S>> =>
    runTurnOn(opts.adapter, { sessionId, ...opts.makeTurnInputs(sessionId, args) });

  const turnPayload = (sessionId: string, token: string, outcome: TurnOutcome<S>): Json => {
    const base: Record<string, Json> = { sessionId, continuationToken: token, status: outcome.status };
    if (outcome.status === "finished" && outcome.output !== undefined) base.output = outcome.output;
    if (outcome.status === "parked") base.wait = outcome.wait as unknown as Json;
    if (outcome.status === "contended") base.current = outcome.current;
    return base;
  };

  const callStart = async (id: number | string | null, args: Json): Promise<JsonRpcResponse> => {
    const sessionId = mintSessionId();
    const outcome = await runOne(sessionId, args);
    const token = mintToken();
    tokens.set(sessionId, token);
    return ok(id, toolResult(turnPayload(sessionId, token, outcome)));
  };

  const callMessage = async (id: number | string | null, args: Record<string, Json>): Promise<JsonRpcResponse> => {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    if (!sessionId || !tokens.has(sessionId)) return err(id, UNKNOWN_SESSION, `unknown session '${sessionId}'`);
    const presented = typeof args.continuationToken === "string" ? args.continuationToken : null;
    if (presented === null || presented === "") return err(id, MISSING_TOKEN, "missing continuationToken");
    if (presented !== tokens.get(sessionId)) return err(id, STALE_TOKEN, "stale or invalid continuationToken");
    // ATOMIC single-use: the token check above and this claim run in ONE callback
    // with no `await` between them; a concurrent second message is refused here.
    if (inFlight.has(sessionId)) return err(id, IN_FLIGHT, "a turn is already in flight for this session");
    inFlight.add(sessionId);
    try {
      const outcome = await runOne(sessionId, args);
      const next = mintToken();
      tokens.set(sessionId, next); // rotate ONLY after a committed turn → single-use
      return ok(id, toolResult(turnPayload(sessionId, next, outcome)));
    } finally {
      inFlight.delete(sessionId);
    }
  };

  const handle = async (raw: unknown): Promise<JsonRpcResponse> => {
    const req = raw as Partial<JsonRpcRequest> | null;
    const id = (req && (typeof req.id === "number" || typeof req.id === "string") ? req.id : null) as
      | number
      | string
      | null;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return err(id, INVALID_REQUEST, "invalid JSON-RPC request");
    }
    switch (req.method) {
      case "initialize":
        return ok(id, { protocolVersion: PROTOCOL_VERSION, serverInfo, capabilities: { tools: {} } });
      case "tools/list":
        return ok(id, { tools: [START_TOOL, MESSAGE_TOOL] });
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: Json };
        const args = (params.arguments ?? {}) as Record<string, Json>;
        if (params.name === "start") return callStart(id, args);
        if (params.name === "message") return callMessage(id, args);
        return err(id, INVALID_PARAMS, `unknown tool '${params.name}'`);
      }
      default:
        return err(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  };

  // Frame newline-delimited JSON-RPC over a stream (the manual stdio smoke). A
  // malformed line is answered with a loud parse error, never dropped silently.
  const serve = (input: Readable, output: Writable): void => {
    let buf = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          output.write(JSON.stringify(err(null, PARSE_ERROR, "parse error")) + "\n");
          continue;
        }
        void handle(parsed).then((resp) => output.write(JSON.stringify(resp) + "\n"));
      }
    });
  };

  return { handle, serve };
}
