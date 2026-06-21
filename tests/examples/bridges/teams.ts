// Microsoft Teams reference bridge, Outgoing-Webhook model. A thin
// adapter over the generic REST-protocol bridge — a Bot-Framework Activity in, a message
// Activity out. Auth is HMAC-SHA256 over the raw body with a base64 shared secret, sent
// as `Authorization: HMAC <base64sig>` (Teams' Outgoing-Webhook signing). Imports only
// @irisrun/bridge + node:crypto. (Full Bot-Framework JWT auth is the heavier production
// path — documented, not implemented in this reference.)
import { createHmac, timingSafeEqual } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge } from "@irisrun/bridge";

type TeamsReply = { type: "message"; text: string };

// Strip a leading <at>DisplayName</at> mention (name-agnostic) and trim.
function stripMention(text: string): string {
  return text.replace(/^\s*<at>[^<]*<\/at>\s*/, "").trim();
}

export function teamsAdapter(opts: { sharedSecret: string }): PlatformAdapter<TeamsReply> {
  // The Outgoing-Webhook secret is a base64 string; decode to the HMAC key bytes.
  const keyBytes = (() => {
    try {
      return opts.sharedSecret ? Buffer.from(opts.sharedSecret, "base64") : null;
    } catch {
      return null;
    }
  })();
  return {
    name: "teams",
    verify(headers, rawBody) {
      if (!keyBytes || keyBytes.length === 0) return false;
      const auth = headers["authorization"];
      if (typeof auth !== "string" || !auth.startsWith("HMAC ")) return false;
      const presented = auth.slice("HMAC ".length);
      const expected = createHmac("sha256", keyBytes).update(Buffer.from(rawBody, "utf8")).digest("base64");
      const a = Buffer.from(presented, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
    parse(rawBody) {
      let act: { type?: string; text?: string; conversation?: { id?: string } };
      try {
        act = JSON.parse(rawBody);
      } catch {
        return { kind: "ignore", reason: "malformed JSON" };
      }
      if (act.type !== "message" || typeof act.text !== "string" || act.conversation?.id === undefined) {
        return { kind: "ignore", reason: `unhandled activity type ${act.type}` };
      }
      const text = stripMention(act.text);
      return { kind: "message", conversationId: act.conversation.id, text };
    },
    formatReply(reply) {
      return { type: "message", text: `(${reply.status}) ${JSON.stringify(reply.output)}` };
    },
  };
}

/** Convenience: a ready-to-serve Teams Outgoing-Webhook bridge over an Iris REST channel. */
export function makeTeamsBridge(opts: {
  baseUrl: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}): PlatformBridge<TeamsReply> {
  return makePlatformBridge(teamsAdapter({ sharedSecret: opts.sharedSecret }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}
