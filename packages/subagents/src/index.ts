// @iris/subagents — public surface (host-side). Wires the `subagent` EffectKind: an agent
// delegates a sub-task to a child agent (its own durable session). Pure id derivation +
// a host-side child runner + the `subagent` performer.
export const PACKAGE = "@iris/subagents";

export { childSessionId } from "./id.ts";
export { driveToCompletion, DEFAULT_MAX_TURNS } from "./drive.ts";
export type { DriveToCompletionDeps, ChildOutcome } from "./drive.ts";
export { makeSubagentPerformer } from "./performer.ts";
export type { SubagentPerformerDeps, ResolvedChild } from "./performer.ts";
