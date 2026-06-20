// @irisrun/channel-core — the narrow, replay-safe channel PORT.
// The two-identifier protocol (mint sessionId, own/rotate a single-use continuation
// token, atomic single-use, loud refusals) in one place, behind which channel-rest,
// channel-mcp, and channel-slack are interchangeable — proven by a shared conformance
// suite any channel must pass. Depends only on @irisrun/core types.
export const PACKAGE = "@irisrun/channel-core";

export { makeChannelSession } from "./session.ts";
export type {
  ChannelSession,
  ChannelSessionOptions,
  ChannelRefusal,
  StartResult,
  ContinueResult,
  AdvanceResult,
} from "./session.ts";
export type { ChannelEvent } from "./events.ts";
export { toOutcomeEvent } from "./events.ts";
export type { Inbound, ChannelPort } from "./port.ts";
