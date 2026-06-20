// @irisrun/channel-slack — a first-party Slack channel for DURABLE HITL. Built on
// the channel port, it showcases the moat where a buyer feels it:
// a Slack approval that pauses for hours, survives a redeploy, and resumes the SAME
// session byte-identically. Zero runtime deps (node:crypto signature verify + fetch).
export const PACKAGE = "@irisrun/channel-slack";

export { makeSlackChannel } from "./slack.ts";
export type { SlackChannel, SlackChannelOptions, SlackHandlerResult, SlackOutbound } from "./slack.ts";
export { verifySlackSignature } from "./verify.ts";
export type { VerifyInput } from "./verify.ts";
