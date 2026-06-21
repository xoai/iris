// The platform-bridge harness: a thin ADAPTER (verify auth + parse the platform's
// inbound + format its outbound) over the generic, fetch-only `makeBridgeSession`.
// The flow is identical for every platform — verify → parse → drive → format — so a
// new platform is just a new adapter, zero core changes.
import { makeBridgeSession, type BridgeReply } from "./session.ts";

/** A platform-specific adapter. `Reply` is the platform's outbound HTTP-response body. */
export interface PlatformAdapter<Reply> {
  name: string;
  /** Platform request authenticity (signature / secret token). Loud false, never throws. */
  verify(headers: Record<string, string | undefined>, rawBody: string): boolean;
  /** Normalize the platform inbound to a channel intent. */
  parse(rawBody: string):
    | { kind: "message"; conversationId: string; text: string }
    | { kind: "handshake"; response: Reply } // e.g. Discord PING → PONG (no turn)
    | { kind: "ignore"; reason: string };
  /** Map the channel reply to the platform's outbound shape. */
  formatReply(reply: BridgeReply): Reply;
}

export interface PlatformBridgeResult<Reply> {
  status: number;
  body: Reply | { error: string } | { ok: true; reason: string };
}

export interface PlatformBridge<Reply> {
  handle(headers: Record<string, string | undefined>, rawBody: string): Promise<PlatformBridgeResult<Reply>>;
}

/**
 * Wire a PlatformAdapter to the REST-protocol bridge session. Verify-first: an
 * unverified body is `401` and NEVER drives a turn.
 */
export function makePlatformBridge<Reply>(
  adapter: PlatformAdapter<Reply>,
  opts: { baseUrl: string; fetchImpl?: typeof fetch },
): PlatformBridge<Reply> {
  const session = makeBridgeSession({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  return {
    async handle(headers, rawBody) {
      // 1. Authenticity FIRST — never process an unverified body.
      if (!adapter.verify(headers, rawBody)) {
        return { status: 401, body: { error: `${adapter.name}: signature verification failed` } };
      }
      const inbound = adapter.parse(rawBody);
      if (inbound.kind === "handshake") return { status: 200, body: inbound.response };
      // An ignored (but authenticated) event is a SUCCESS, not an error — 200 + a reason.
      if (inbound.kind === "ignore") return { status: 200, body: { ok: true, reason: `ignored: ${inbound.reason}` } };
      try {
        // 2. Drive the durable session over the wire protocol, then format the reply.
        const reply = await session.onMessage({ conversationId: inbound.conversationId, text: inbound.text });
        return { status: 200, body: adapter.formatReply(reply) };
      } catch (err) {
        // The channel surfaced a loud failure (e.g. a non-2xx) — propagate, never swallow.
        return { status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
