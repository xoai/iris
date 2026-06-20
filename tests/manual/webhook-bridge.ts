// Reference protocol BRIDGE (roadmap v0.2 §12). The whole point of a bridge: a
// platform (Discord, Telegram, a generic webhook) is reached by an EXTERNAL process
// that speaks the existing Iris REST channel protocol — NOT a first-party Iris package.
// This file deliberately imports NOTHING from @irisrun/*: a bridge needs only the wire
// protocol (HTTP + the rotated continuationToken), so it can be written in any
// language. tests/bridge-reference.test.ts asserts this file has zero @irisrun imports.

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

export interface WebhookBridge {
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
 * A generic-webhook bridge: maps `{conversationId, text}` ↔ the Iris REST channel.
 * It holds a `conversationId → SessionHandle` map and ADOPTS the rotated
 * continuationToken every turn — exactly the channel's single-use discipline, mirrored
 * from outside. Uses only `fetch` + the wire protocol; zero Iris dependencies, so the
 * same shape ports to any language. Additional platforms need NO core changes — only a
 * new adapter that produces `BridgeInbound` and consumes `BridgeReply`.
 */
export function makeWebhookBridge(opts: { baseUrl: string; fetchImpl?: typeof fetch }): WebhookBridge {
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
