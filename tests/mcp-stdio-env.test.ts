// The MCP-stdio transport passes a scoped `env` to the spawned server (M3 — so a
// declared secret like MEM0_API_KEY reaches an MCP memory server). A fake server echoes
// process.env.IRIS_TEST_VAR back through tools/call. Absent env → inherit (unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMcpStdioTransport } from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";

const NODE = process.execPath;

// A fake MCP server (newline-delimited JSON-RPC 2.0) that echoes an env var in its result.
const ENV_ECHO_SERVER = `
let buf = "";
function send(o){ process.stdout.write(JSON.stringify(o)+"\\n"); }
process.stdin.on("data",(d)=>{ buf+=d; let nl;
  while((nl=buf.indexOf("\\n"))>=0){ const line=buf.slice(0,nl); buf=buf.slice(nl+1); if(!line.trim())continue;
    const msg=JSON.parse(line);
    if(msg.method==="initialize"){ send({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"2024-11-05",capabilities:{},serverInfo:{name:"env-echo",version:"1"}}}); }
    else if(msg.method==="tools/call"){ send({jsonrpc:"2.0",id:msg.id,result:{content:[{type:"text",text:"VAR="+(process.env.IRIS_TEST_VAR||"<unset>")}],isError:false}}); }
  }
});
`;

function contract(location: string): ToolContract {
  return { name: "echo", description: "", inputSchema: {}, transport: "mcp", location, retrySafe: false };
}
function textOf(res: { ok: boolean; value?: unknown }): string {
  return res.ok ? (res.value as { content: { text: string }[] }).content[0].text : "";
}

test("mcp-stdio: a scoped env reaches the spawned server process", async () => {
  const mcp = makeMcpStdioTransport(
    { srv: { command: NODE, args: ["-e", ENV_ECHO_SERVER] } },
    { env: { IRIS_TEST_VAR: "reached", PATH: process.env.PATH ?? "" } },
  );
  const res = await mcp.invoke(contract("mcp://srv"), {});
  assert.equal(res.ok, true);
  assert.match(textOf(res), /VAR=reached/);
});

test("mcp-stdio: no env → the server inherits process.env (unchanged behavior)", async () => {
  process.env.IRIS_TEST_VAR = "inherited";
  try {
    const mcp = makeMcpStdioTransport({ srv: { command: NODE, args: ["-e", ENV_ECHO_SERVER] } });
    const res = await mcp.invoke(contract("mcp://srv"), {});
    assert.equal(res.ok, true);
    assert.match(textOf(res), /VAR=inherited/);
  } finally {
    delete process.env.IRIS_TEST_VAR;
  }
});
