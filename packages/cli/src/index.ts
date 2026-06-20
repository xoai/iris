// iris — public surface (the command functions; the bin is cli-main.ts).
export const PACKAGE = "iris-runtime";

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
  loadApprovalPolicy,
  subagentPerformers,
} from "./iris.ts";
export type {
  CliBuildOptions,
  CliRunOptions,
  CliServeOptions,
  ServeHandle,
  CliDeployOptions,
  DeployResult,
  CliSubagents,
} from "./iris.ts";
export { loadSubagents } from "./subagents-cfg.ts";
export type { SubagentEntry, SubagentsConfig } from "./subagents-cfg.ts";
export { cmdAudit } from "./audit-cmd.ts";
export type { CliAuditOptions } from "./audit-cmd.ts";
export { cmdJournalExport, cmdJournalVerify, cmdJournalImport } from "./journal-cmd.ts";
export type {
  CliJournalExportOptions,
  CliJournalExportResult,
  CliJournalVerifyOptions,
  CliJournalVerifyResult,
  CliJournalImportOptions,
  CliJournalImportResult,
} from "./journal-cmd.ts";
export { cmdEval, loadEvalSuite } from "./eval-cmd.ts";
export type { EvalSuite, CmdEvalOptions, CmdEvalResult } from "./eval-cmd.ts";
export { cmdSchedule } from "./schedule-cmd.ts";
export type { CmdScheduleOptions, CmdScheduleResult } from "./schedule-cmd.ts";
export { echoStreamingPerformer } from "./echo.ts";
export {
  wrapModelForImage,
  makeChatFakeModel,
  makeChatStreamingFakeModel,
  makeStreamSink,
  renderOutcome,
  chatTurn,
  resumeTurn,
  runChat,
  hitlRequest,
  parseApproval,
  renderHitlRequest,
  renderApprovalResult,
} from "./chat.ts";
export type { ChatDeps, StreamSink, HitlRequest } from "./chat.ts";
export { loadBundledTools } from "./tools.ts";
export type { BundledTools } from "./tools.ts";
export {
  providerNameForModel,
  stripModelPrefix,
  providerDescriptor,
  loadModelProvider,
} from "./providers.ts";
export type {
  ProviderName,
  ProviderDescriptor,
  LoadedProvider,
  ModelPerformerOptions,
  StreamingModelPerformerOptions,
} from "./providers.ts";
