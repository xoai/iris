// Google Chat reference bridge. A thin adapter over the generic REST-protocol bridge — a
// Chat event in, a Chat message out. Auth here is the SIMPLE shared-token mode: a token you
// configure is presented in the `Authorization` header (raw or `Bearer <token>`), compared
// constant-time. (Production Google Chat sends a Google-signed Bearer JWT validated against
// Google's JWKS — the heavier path, documented, not implemented in this reference.) Imports
// only @irisrun/bridge + node:crypto.
import { timingSafeEqual } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge, type OpenBridge } from "@irisrun/bridge";

// Google Chat accepts a message object in the webhook RESPONSE — the simplest reply path.
type GoogleChatReply = { text: string };

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function googleChatAdapter(opts: { token: string }): PlatformAdapter<GoogleChatReply> {
  return {
    name: "googlechat",
    verify(headers) {
      if (!opts.token) return false;
      const auth = headers["authorization"];
      if (typeof auth !== "string") return false;
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
      return constantTimeEqual(presented, opts.token);
    },
    parse(rawBody) {
      let ev: { type?: string; message?: { text?: string }; space?: { name?: string } };
      try {
        ev = JSON.parse(rawBody);
      } catch {
        return { kind: "ignore", reason: "malformed JSON" };
      }
      // Only a MESSAGE event drives a turn; ADDED_TO_SPACE / REMOVED_FROM_SPACE / etc. are
      // authenticated lifecycle events with no user text → ignore.
      if (ev.type !== "MESSAGE" || typeof ev.message?.text !== "string" || typeof ev.space?.name !== "string") {
        return { kind: "ignore", reason: `unhandled event type ${ev.type}` };
      }
      return { kind: "message", conversationId: ev.space.name, text: ev.message.text };
    },
    formatReply(reply) {
      return { text: `(${reply.status}) ${JSON.stringify(reply.output)}` };
    },
  };
}

/** Convenience: a ready-to-serve Google Chat bridge over an Iris REST channel. */
export function makeGoogleChatBridge(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): PlatformBridge<GoogleChatReply> {
  return makePlatformBridge(googleChatAdapter({ token: opts.token }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}

/** Forkless entry for `iris bridge`: reads the shared verification token from the
 *  environment (`GOOGLE_CHAT_TOKEN`). Imports only @irisrun/bridge. */
export const openBridge: OpenBridge = (o) =>
  googleChatAdapter({ token: (o?.env ?? process.env).GOOGLE_CHAT_TOKEN ?? "" });
