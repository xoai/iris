// @irisrun/channel-conformance — the importable certification suite for the Iris
// channel port (the two-identifier protocol). A channel that passes it is replay-safe
// by construction.
export const PACKAGE = "@irisrun/channel-conformance";
export { runChannelPortConformance } from "./port.ts";
export { register } from "./register.ts";
export type {
  ConformanceCase,
  Refusal,
  ContinueOutcome,
  ChannelOps,
  ChannelPortFixture,
  HoldConnectionOps,
} from "./types.ts";
