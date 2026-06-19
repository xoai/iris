// @iris/cli — public surface (the command functions; the bin is cli-main.ts).
export const PACKAGE = "@iris/cli";

export {
  cmdInit,
  cmdBuild,
  cmdInspect,
  cmdVerify,
  cmdPush,
  cmdPull,
  cmdRun,
  cmdServe,
} from "./iris.ts";
export type { CliBuildOptions, CliRunOptions, CliServeOptions, ServeHandle } from "./iris.ts";
export { echoStreamingPerformer } from "./echo.ts";
export { wrapModelForImage, makeChatFakeModel, renderOutcome, chatTurn, runChat } from "./chat.ts";
export type { ChatDeps } from "./chat.ts";
