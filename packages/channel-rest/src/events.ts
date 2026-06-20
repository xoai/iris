// The channel wire-event model now lives in @irisrun/channel-core (roadmap v0.2 §10)
// so EVERY transport shares one vocabulary. This file re-exports it for back-compat:
// existing imports of { StreamEvent, toOutcomeEvent } from @irisrun/channel-rest still
// resolve. `StreamEvent` is the channel-core `ChannelEvent` (same shape).
export type { ChannelEvent as StreamEvent } from "@irisrun/channel-core";
export { toOutcomeEvent } from "@irisrun/channel-core";
