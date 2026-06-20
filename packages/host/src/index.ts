// @irisrun/host — public surface (host-side; makes "same image, different host" explicit).
export const PACKAGE = "@irisrun/host";

export { runTurnOn, checkHostCapabilities } from "./adapter.ts";
export type { HostAdapter, RunTurnOnOptions } from "./adapter.ts";
export { diffCapabilities, assertDeployable } from "./capabilities.ts";
export type { CapabilityGap } from "./capabilities.ts";
