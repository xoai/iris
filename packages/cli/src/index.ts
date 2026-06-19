// iris — public surface (the command functions; the bin is cli-main.ts).
export const PACKAGE = "iris";

export {
  cmdInit,
  cmdBuild,
  cmdInspect,
  cmdVerify,
  cmdPush,
  cmdPull,
  cmdRun,
  cmdServe,
  cmdDeploy,
  governancePerformers,
} from "./iris.ts";
export type {
  CliBuildOptions,
  CliRunOptions,
  CliServeOptions,
  ServeHandle,
  CliDeployOptions,
  DeployResult,
} from "./iris.ts";
export { echoStreamingPerformer } from "./echo.ts";
export {
  wrapModelForImage,
  makeChatFakeModel,
  makeChatStreamingFakeModel,
  makeStreamSink,
  renderOutcome,
  chatTurn,
  runChat,
} from "./chat.ts";
export type { ChatDeps, StreamSink } from "./chat.ts";
export { loadBundledTools } from "./tools.ts";
export type { BundledTools } from "./tools.ts";
