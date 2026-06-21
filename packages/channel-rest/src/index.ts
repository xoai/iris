// @irisrun/channel-rest — public surface (host; in-process node:http REST channel).
export const PACKAGE = "@irisrun/channel-rest";

export { makeRestChannel } from "./server.ts";
export type { RestChannel, RestChannelOptions, TurnInputs, MakeTurnInputs, WebHandler } from "./server.ts";
export type { StreamEvent } from "./events.ts";
export { toOutcomeEvent } from "./events.ts";
export {
  acceptKey,
  decodeFrames,
  encodeTextFrame,
  encodeCloseFrame,
  encodePongFrame,
  makeWsFramer,
} from "./ws.ts";
export type { WsFrame, WsFramerCallbacks } from "./ws.ts";
