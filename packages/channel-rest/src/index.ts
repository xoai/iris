// @iris/channel-rest — public surface (host; in-process node:http REST channel).
export const PACKAGE = "@iris/channel-rest";

export { makeRestChannel } from "./server.ts";
export type { RestChannel, RestChannelOptions, TurnInputs } from "./server.ts";
