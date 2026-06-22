// @irisrun/tools — public surface (host-side; zero external deps).
export const PACKAGE = "@irisrun/tools";

export { makeToolPerformer } from "./performer.ts";

export { contractDigest, makeToolRegistry } from "./contract.ts";
export type { ToolContract, ToolRegistry } from "./contract.ts";

export { makeToolInvoker, toolFailure, resolveLocality } from "./invoker.ts";
export type {
  ToolResult,
  Transport,
  ToolInvoker,
  TransportTable,
  ToolLocality,
  LogicalTool,
  LocalityOption,
  LocalityOptions,
} from "./invoker.ts";

export { makeInProcessTransport } from "./transports/in-process.ts";
export type { InProcessFn } from "./transports/in-process.ts";

export { makeSubprocessTransport } from "./transports/subprocess.ts";
export type { SubprocessSpec, SubprocessOptions, SandboxExecutor } from "./transports/subprocess.ts";

export { makeMcpStdioTransport } from "./transports/mcp-stdio.ts";
export type { McpServerSpec, McpStdioOptions } from "./transports/mcp-stdio.ts";

export {
  makeGrpcTransport,
  jsonCodec,
  frameMessage,
  makeFrameReader,
} from "./transports/grpc.ts";
export type { GrpcCodec, GrpcOptions, FrameReader } from "./transports/grpc.ts";
