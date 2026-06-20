import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMcpStdioTransport } from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";

const NODE = process.execPath;

// A REAL minimal MCP server over stdio (newline-delimited JSON-RPC 2.0):
// answers `initialize`, then `tools/call` — echoing arguments, or returning
// isError:true when arguments.fail is set.
const MCP_SERVER = `
let buf = "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp", version: "1" } } });
    } else if (msg.method === "tools/call") {
      const args = (msg.params && msg.params.arguments) || {};
      if (args.fail) {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "tool failed on purpose" }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "hello " + (args.who || "world") }], isError: false } });
      }
    }
  }
});
`;

function contract(location: string): ToolContract {
  return {
    name: "greet",
    description: "greet a name",
    inputSchema: {},
    transport: "mcp",
    location,
    retrySafe: false,
  };
}

test("T3: MCP-stdio invokes a REAL server child (initialize → tools/call) → {ok:true}", async () => {
  const mcp = makeMcpStdioTransport({
    greeter: { command: NODE, args: ["-e", MCP_SERVER] },
  });
  const res = await mcp.invoke(contract("mcp://greeter"), { who: "iris" });
  assert.equal(res.ok, true);
  // value is the MCP result; its text content carries the greeting.
  const value = res.ok ? (res.value as { content: { text: string }[] }) : null;
  assert.equal(value?.content?.[0]?.text, "hello iris");
});

test("T3: an isError:true MCP result → {ok:false}", async () => {
  const mcp = makeMcpStdioTransport({
    greeter: { command: NODE, args: ["-e", MCP_SERVER] },
  });
  const res = await mcp.invoke(contract("mcp://greeter"), { fail: true });
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error.message : "", /failed on purpose/);
});

test("T3: an unregistered mcp server → loud {ok:false}", async () => {
  const mcp = makeMcpStdioTransport({});
  const res = await mcp.invoke(contract("mcp://nope"), {});
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "unknown_tool");
});
