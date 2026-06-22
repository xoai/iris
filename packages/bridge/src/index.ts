// @irisrun/bridge — the optional Node SDK for building a platform bridge to the Iris
// REST channel. Zero deps; speaks only HTTP. The protocol is the contract — a bridge
// can also be written in any language with no SDK at all.
export const PACKAGE = "@irisrun/bridge";
export { makeBridgeSession } from "./session.ts";
export type { BridgeInbound, BridgeReply, BridgeSession } from "./session.ts";
export { makePlatformBridge } from "./platform.ts";
export type { PlatformAdapter, PlatformBridge, PlatformBridgeResult, OpenBridge } from "./platform.ts";
export { runBridgeConformance, runAdapterConformance, register } from "./conformance.ts";
export type { ConformanceCase } from "./conformance.ts";
