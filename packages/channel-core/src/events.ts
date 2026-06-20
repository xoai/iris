// The channel wire-event model. Re-homed from channel-rest so
// EVERY channel transport shares one event vocabulary. A `record` is a committed
// JournalRecord (the deep-copied journal timeline); a `delta` is a non-journaled
// model token; the terminal `outcome` carries the TurnOutcome + the rotated
// continuationToken; an `error` surfaces a mid-stream failure loudly.
//
// `record`/`delta` are STREAMING-only events. A buffered transport (channel-mcp, a
// buffered Slack reply) passes no `emit` and simply never receives them — homing the
// full union here is intentional (one vocabulary), NOT a push to make every channel
// stream.
import type { Json, TurnOutcome } from "@irisrun/core";

export type ChannelEvent =
  | { type: "record"; record: Json }
  | { type: "delta"; text: string }
  | {
      type: "outcome";
      sessionId: string;
      status: TurnOutcome<Json>["status"];
      output?: Json;
      wait?: Json;
      current?: number;
      continuationToken?: string;
    }
  | { type: "error"; message: string };

// Map a finished turn to the terminal `outcome` event, plus the rotated token.
// `token` is omitted only when the channel did not (re)issue one. Mirrors the
// buffered turn-response mapping so streaming and buffered agree field-for-field.
export function toOutcomeEvent<S extends Json>(
  sessionId: string,
  outcome: TurnOutcome<S>,
  token?: string,
): ChannelEvent {
  const ev: Extract<ChannelEvent, { type: "outcome" }> = {
    type: "outcome",
    sessionId,
    status: outcome.status,
  };
  if (outcome.status === "finished" && outcome.output !== undefined) ev.output = outcome.output;
  if (outcome.status === "parked") ev.wait = outcome.wait as unknown as Json;
  if (outcome.status === "contended") ev.current = outcome.current;
  if (token !== undefined) ev.continuationToken = token;
  return ev;
}
