// @iris/channel-mcp — public surface (host; agent exposed AS an MCP server).
export const PACKAGE = "@iris/channel-mcp";

export { makeMcpChannel } from "./server.ts";
export type {
  McpChannel,
  McpChannelOptions,
  TurnInputs,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./server.ts";
