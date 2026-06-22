// WhatsApp (Meta Cloud API) reference bridge. A thin adapter over the generic
// REST-protocol bridge — a WhatsApp webhook payload in, a Cloud-API send body out. Auth is
// `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the RAW body with the app secret
// (Meta's required scheme), compared constant-time. Imports only @irisrun/bridge +
// node:crypto — nothing from the Iris runtime/core.
import { createHmac, timingSafeEqual } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge, type OpenBridge } from "@irisrun/bridge";

// A Cloud-API text-send body (the operator POSTs this to /{phoneNumberId}/messages; the
// bridge returns it so a thin server can forward it). conversationId is the sender's wa_id.
type WhatsAppReply = { messaging_product: "whatsapp"; to: string; type: "text"; text: { body: string } };

function constantTimeEqualHex(presentedHex: string, expectedHex: string): boolean {
  // Buffer.from(_, "hex") never throws (it silently drops non-hex), so the length guard —
  // NOT a try/catch — is what rejects a malformed/short signature.
  const a = Buffer.from(presentedHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || a.length !== 32) return false; // sha256 = 32 bytes
  return timingSafeEqual(a, b);
}

export function whatsappAdapter(opts: { appSecret: string }): PlatformAdapter<WhatsAppReply> {
  return {
    name: "whatsapp",
    verify(headers, rawBody) {
      if (!opts.appSecret) return false;
      const header = headers["x-hub-signature-256"];
      if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
      const presented = header.slice("sha256=".length);
      const expected = createHmac("sha256", opts.appSecret).update(Buffer.from(rawBody, "utf8")).digest("hex");
      return constantTimeEqualHex(presented, expected);
    },
    parse(rawBody) {
      let p: {
        entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string; text?: { body?: string } }> } }> }>;
      };
      try {
        p = JSON.parse(rawBody);
      } catch {
        return { kind: "ignore", reason: "malformed JSON" };
      }
      // The first text message in the first change of the first entry; status/read events
      // and template-only payloads carry no `messages[]` → ignore (authenticated, no turn).
      const msg = p.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg || typeof msg.from !== "string" || typeof msg.text?.body !== "string") {
        return { kind: "ignore", reason: "no inbound text message (status/non-text event)" };
      }
      return { kind: "message", conversationId: msg.from, text: msg.text.body };
    },
    formatReply(reply) {
      return { messaging_product: "whatsapp", to: reply.conversationId, type: "text", text: { body: `(${reply.status}) ${JSON.stringify(reply.output)}` } };
    },
  };
}

/** Convenience: a ready-to-serve WhatsApp bridge over an Iris REST channel. */
export function makeWhatsappBridge(opts: {
  baseUrl: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}): PlatformBridge<WhatsAppReply> {
  return makePlatformBridge(whatsappAdapter({ appSecret: opts.appSecret }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}

/** Forkless entry for `iris bridge`: reads the Meta app secret from the environment
 *  (`WHATSAPP_APP_SECRET`). Imports only @irisrun/bridge. */
export const openBridge: OpenBridge = (o) =>
  whatsappAdapter({ appSecret: (o?.env ?? process.env).WHATSAPP_APP_SECRET ?? "" });
