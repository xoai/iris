// Types for the channel-port conformance suite. The `Refusal` taxonomy is pinned to
// the real `ChannelRefusal` from @irisrun/channel-core so the suite can never drift
// from the driver.
import type { ChannelRefusal } from "@irisrun/channel-core";

/** The four loud refusals a channel may return for a continue. */
export type Refusal = ChannelRefusal;

/** One conformance check. `fn` throws (node:assert) on failure. Runner-agnostic. */
export interface ConformanceCase {
  name: string;
  fn: () => Promise<void>;
}

/** A continue outcome as the fixture surfaces it (the wire mapping is the fixture's). */
export type ContinueOutcome =
  | { ok: true; token: string; status: string }
  | { ok: false; refusal: Refusal };

/** A normalized driver over one channel transport. `setNext` flips the underlying
 *  store for the NEXT continue so contended/aborted can be forced through the real
 *  transport. */
export interface ChannelOps {
  start(): Promise<{ sessionId: string; token: string }>;
  setNext(mode: "ok" | "contend" | "abort"): void;
  continueTurn(sessionId: string, token: string | null): Promise<ContinueOutcome>;
  close(): Promise<void>;
}

/** Opt-in: the connection-authorized (token:null) path a held-connection transport
 *  (WebSocket / gRPC streaming) uses — it advances by the connection, not a presented
 *  token. Supply `ChannelPortFixture.holdConnection` to certify it. */
export interface HoldConnectionOps {
  open(): { sessionId: string };
  advance(sessionId: string): Promise<{ ok: boolean; token?: string; status?: string }>;
  close(): Promise<void>;
}

export interface ChannelPortFixture {
  name: string;
  create(): Promise<ChannelOps>;
  /** Opt-in: certify the hold-connection (token:null) path. Token-based channels
   *  (REST/MCP) omit it and the suite skips those cases. */
  holdConnection?(): Promise<HoldConnectionOps>;
}
