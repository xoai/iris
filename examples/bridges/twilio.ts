// Twilio (SMS / WhatsApp-via-Twilio) reference bridge. A thin adapter over the generic
// REST-protocol bridge — a Twilio form-encoded webhook in, TwiML out. Auth is the
// `X-Twilio-Signature` scheme: HMAC-SHA1, base64, over the request URL followed by the POST
// params sorted by key and concatenated as key+value. The request URL is NOT available to
// `verify(headers, rawBody)`, so the adapter is CONFIGURED with the public webhook URL
// (exactly how server-side Twilio validation works behind a proxy). Imports only
// @irisrun/bridge + node:crypto.
import { createHmac, timingSafeEqual } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge, type OpenBridge } from "@irisrun/bridge";

// Twilio lets the webhook RESPONSE carry TwiML (XML) — the simplest reply path.
type TwilioReply = string;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The Twilio signature base string: the URL, then each POST param (sorted by key)
 *  appended as key immediately followed by value. */
function twilioSignatureBase(url: string, rawBody: string): string {
  const params = [...new URLSearchParams(rawBody).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return params.reduce((acc, [k, v]) => acc + k + v, url);
}

export function twilioAdapter(opts: { authToken: string; url: string }): PlatformAdapter<TwilioReply> {
  return {
    name: "twilio",
    verify(headers, rawBody) {
      if (!opts.authToken || !opts.url) return false;
      const presented = headers["x-twilio-signature"];
      if (typeof presented !== "string") return false;
      const expected = createHmac("sha1", opts.authToken).update(twilioSignatureBase(opts.url, rawBody), "utf8").digest("base64");
      return constantTimeEqual(presented, expected);
    },
    parse(rawBody) {
      const form = new URLSearchParams(rawBody);
      const from = form.get("From");
      const body = form.get("Body");
      if (from === null || body === null || body === "") {
        return { kind: "ignore", reason: "not an inbound SMS/message (no From/Body)" };
      }
      return { kind: "message", conversationId: from, text: body };
    },
    formatReply(reply) {
      const text = xmlEscape(`(${reply.status}) ${JSON.stringify(reply.output)}`);
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text}</Message></Response>`;
    },
  };
}

/** Convenience: a ready-to-serve Twilio bridge over an Iris REST channel. */
export function makeTwilioBridge(opts: {
  baseUrl: string;
  authToken: string;
  url: string; // the PUBLIC webhook URL Twilio signs against
  fetchImpl?: typeof fetch;
}): PlatformBridge<TwilioReply> {
  return makePlatformBridge(twilioAdapter({ authToken: opts.authToken, url: opts.url }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}

/** Forkless entry for `iris bridge`: reads the auth token + public webhook URL from the
 *  environment (`TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL`). Imports only @irisrun/bridge. */
export const openBridge: OpenBridge = (o) => {
  const env = o?.env ?? process.env;
  return twilioAdapter({ authToken: env.TWILIO_AUTH_TOKEN ?? "", url: env.TWILIO_WEBHOOK_URL ?? "" });
};
