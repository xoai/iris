// The bridge session: maps a platform conversation to a durable Iris session over
// the REST channel protocol, and ADOPTS the rotated continuationToken every turn —
// the channel's single-use discipline, mirrored from outside. Speaks only `fetch` +
// the wire protocol, so the same shape ports to any language and needs NO Iris core
// changes for a new platform.

/** A platform-shaped inbound message (what a Discord/Telegram/webhook adapter yields). */
export interface BridgeInbound {
  conversationId: string; // the platform's conversation/thread/chat id
  text: string;
}

/** A platform-shaped reply (what the adapter posts back). */
export interface BridgeReply {
  conversationId: string;
  status: string;
  output: unknown;
}

export interface BridgeSession {
  onMessage(inbound: BridgeInbound): Promise<BridgeReply>;
}

interface SessionHandle {
  sessionId: string;
  token: string;
}

interface TurnResponse {
  sessionId: string;
  continuationToken: string;
  status: string;
  output?: unknown;
}

/**
 * A bridge session over the Iris REST channel: holds a `conversationId →
 * SessionHandle` map and adopts the rotated continuationToken every turn. Additional
 * platforms need only an adapter that produces `BridgeInbound` and consumes
 * `BridgeReply` (see `makePlatformBridge`).
 */
export function makeBridgeSession(opts: { baseUrl: string; fetchImpl?: typeof fetch }): BridgeSession {
  const doFetch = opts.fetchImpl ?? fetch;
  const handles = new Map<string, SessionHandle>();

  const post = async (url: string, body: unknown): Promise<TurnResponse> => {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`bridge: channel returned HTTP ${res.status}`);
    return (await res.json()) as TurnResponse;
  };

  return {
    async onMessage(inbound: BridgeInbound): Promise<BridgeReply> {
      const message = { role: "user", content: inbound.text };
      const existing = handles.get(inbound.conversationId);
      let resp: TurnResponse;
      if (!existing) {
        // START — mint a session for this conversation.
        resp = await post(`${opts.baseUrl}/v1/session`, { messages: [message] });
      } else {
        // CONTINUE — present the adopted token; the path carries the sessionId.
        resp = await post(`${opts.baseUrl}/v1/session/${existing.sessionId}/message`, {
          continuationToken: existing.token,
          messages: [message],
        });
      }
      // Adopt the rotated token for the next turn in this conversation.
      handles.set(inbound.conversationId, { sessionId: resp.sessionId, token: resp.continuationToken });
      return { conversationId: inbound.conversationId, status: resp.status, output: resp.output ?? null };
    },
  };
}
