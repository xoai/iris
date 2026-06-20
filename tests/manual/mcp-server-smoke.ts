// MANUAL smoke — NOT in the unit suite, NOT typechecked (tests/manual/ is
// outside the tsconfig include + the tests/**/*.test.ts runner glob).
//   IRIS_MCP_SERVER_SMOKE=1 node tests/manual/mcp-server-smoke.ts
//
// Exercises the @irisrun/channel-mcp `serve()` stdio FRAMING path (newline-delimited
// JSON-RPC over a stream) — the part the in-memory `handle()` unit test cannot
// stand in for. It is the agent-AS-MCP-server channel; distinct from the existing
// M3 `tests/manual/mcp-smoke.ts` (agent-AS-CONSUMER-of-MCP-tools). Install-free: it pipes
// JSON-RPC lines through a PassThrough pair (a real client over real stdio is a
// further future smoke).
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeMcpChannel } from "@irisrun/channel-mcp";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const program = {
  initial: { turns: 0 },
  reducer: (s, rec) => (rec.kind === "marker" && rec.payload && rec.payload.marker === "finish" ? { turns: s.turns + 1 } : s),
  step: (s) => ({ type: "finish", output: { turn: s.turns } }),
};

async function main() {
  if (process.env.IRIS_MCP_SERVER_SMOKE !== "1") {
    console.log("skip: set IRIS_MCP_SERVER_SMOKE=1 to run the MCP-server stdio-framing smoke");
    return;
  }
  const adapter = { name: "serverless", capabilities: { long_running: false }, store: new MemoryStateStore(), scheduler: new MemoryScheduler() };
  const channel = makeMcpChannel({ adapter, makeTurnInputs: () => ({ program, performers: {}, clock: { now: () => 1 }, defDigest: "img" }) });

  const input = new PassThrough();
  const output = new PassThrough();
  channel.serve(input, output);

  const responses = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) responses.push(JSON.parse(line)); }
  });
  const waitFor = async (n) => { for (let i = 0; i < 100 && responses.length < n; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(responses.length >= n, `expected ${n} responses, got ${responses.length}: ${JSON.stringify(responses)}`); };

  // select responses by JSON-RPC id (the sync parse-error can arrive before the
  // awaited message response, so position is not reliable — id is).
  const byId = (id) => responses.find((r) => r.id === id);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start", arguments: {} } }) + "\n");
  await waitFor(1);
  assert.ok(byId(1)?.result, `start should return a result, got ${JSON.stringify(byId(1))}`);
  const start = JSON.parse(byId(1).result.content[0].text);
  assert.equal(typeof start.continuationToken, "string");

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "message", arguments: { sessionId: start.sessionId, continuationToken: start.continuationToken } } }) + "\n");
  input.write("{ this is not json\n"); // a genuinely malformed line → loud parse error
  await waitFor(3);
  const cont = JSON.parse(byId(2).result.content[0].text);
  assert.notEqual(cont.continuationToken, start.continuationToken, "token rotated over the stream");
  assert.ok(responses.some((r) => r.error && r.error.code === -32700), "a malformed line is a loud parse error (-32700)");
  console.log("mcp-server-smoke PASS — stdio JSON-RPC framing: start → rotated token → malformed-line parse error");
}

main().catch((e) => { console.error("mcp-server-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
