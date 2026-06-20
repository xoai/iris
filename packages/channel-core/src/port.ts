// The channel PORT — the formal, normalize-inbound / emit-outbound
// contract a platform adapter implements, the way StateStore is the store port. A
// transport's job reduces to: normalizeInbound(platformEvent) → drive the
// ChannelSession (start / continueTurn) → emitOutbound(result). Keeping this narrow is
// what makes channels pluggable and replay-safe by construction.
import type { Json } from "@irisrun/core";
import type { StartResult, ContinueResult } from "./session.ts";

/** A platform event normalized to a channel intent. `ignore` = a platform event the
 *  channel does not act on (a bot's own echo, a health ping, a handshake handled
 *  out of band). `continue` carries the token the platform round-tripped (null when
 *  the transport authorizes by connection rather than token, e.g. a held socket). */
export type Inbound =
  | { kind: "start"; body: Json }
  | { kind: "continue"; sessionId: string; token: string | null; body: Json }
  | { kind: "ignore" };

/**
 * A channel adapter for a platform. `Platform` is the inbound event type (an HTTP
 * request, a JSON-RPC call, a Slack payload); `Reply` is the platform's outbound
 * shape. The driver in between is the shared ChannelSession.
 */
export interface ChannelPort<Platform, Reply> {
  normalizeInbound(ev: Platform): Inbound;
  emitOutbound(result: StartResult<Json> | ContinueResult<Json>): Reply;
}
