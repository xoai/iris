// The wire event model shared by the SSE and WS streaming transports
// (serve-streaming Tasks 4–5). A `record` is a committed JournalRecord (the
// deep-copied journal timeline); a `delta` is a non-journaled model token; the
// terminal `outcome` carries the TurnOutcome + the rotated continuationToken; an
// `error` surfaces a mid-stream failure loudly (after the stream already opened).
// Both transports encode the SAME StreamEvent — SSE as `event:/data:` frames, WS
// as one text frame per event.
import type { Json, TurnOutcome } from "@iris/core";

export type StreamEvent =
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

// Mirrors the buffered `turnResponse()` mapping, plus the rotated token. `token`
// is omitted only when the channel did not (re)issue one.
export function toOutcomeEvent<S extends Json>(
  sessionId: string,
  outcome: TurnOutcome<S>,
  token?: string,
): StreamEvent {
  const ev: Extract<StreamEvent, { type: "outcome" }> = {
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
