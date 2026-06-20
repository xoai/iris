// @irisrun/schedule — public surface (host-side + a pure schedule Program). A recurring job as
// a durable, replayable agent, plus the multi-session pump that drives due wakeups.
export const PACKAGE = "@irisrun/schedule";

export { scheduleProgram } from "./program.ts";
export type { ScheduleConfig, ScheduleJob, ScheduleState, SchedulePhase } from "./program.ts";
export { makeScheduleRunner } from "./runner.ts";
export type { ScheduleRunner, ScheduleRunnerDeps, ResumeInputs, TickResult, Wakeup, WakeupSource } from "./runner.ts";
