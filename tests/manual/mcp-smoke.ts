// MANUAL smoke — NOT in the unit suite, NOT typechecked. Point it at a REAL
// external MCP server over stdio:
//   IRIS_MCP_SMOKE_CMD="npx -y @modelcontextprotocol/server-everything" \
//   IRIS_MCP_TOOL=echo IRIS_MCP_INPUT='{"message":"hi"}' node tests/manual/mcp-smoke.ts
import { makeMcpStdioTransport } from "@irisrun/tools";

async function main() {
  const cmdline = process.env.IRIS_MCP_SMOKE_CMD;
  if (!cmdline) {
    console.log('skip: set IRIS_MCP_SMOKE_CMD="<server command>" to run this smoke');
    return;
  }
  const parts = cmdline.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);
  const toolName = process.env.IRIS_MCP_TOOL || "echo";
  const input = JSON.parse(process.env.IRIS_MCP_INPUT || "{}");

  const mcp = makeMcpStdioTransport({ server: { command, args } });
  const res = await mcp.invoke(
    {
      name: toolName,
      description: "",
      inputSchema: {},
      transport: "mcp",
      location: "mcp://server",
      retrySafe: false,
    },
    input,
  );
  console.log("mcp-smoke result:", JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
