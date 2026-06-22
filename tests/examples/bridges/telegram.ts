// Telegram reference bridge. A thin adapter over the generic
// REST-protocol bridge — a Telegram Update in, a webhook-response method out. Auth is
// the `X-Telegram-Bot-Api-Secret-Token` header (set when you call setWebhook with
// secret_token), compared constant-time. Imports only @irisrun/bridge + node:crypto.
import { timingSafeEqual } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge, type OpenBridge } from "@irisrun/bridge";

// Telegram lets the webhook RESPONSE carry a method call — the simplest reply path.
type TelegramReply = { method: "sendMessage"; chat_id: string; text: string };

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function telegramAdapter(opts: { secretToken: string }): PlatformAdapter<TelegramReply> {
  return {
    name: "telegram",
    verify(headers) {
      if (!opts.secretToken) return false;
      const presented = headers["x-telegram-bot-api-secret-token"];
      if (typeof presented !== "string") return false;
      return constantTimeEqual(presented, opts.secretToken);
    },
    parse(rawBody) {
      let u: { message?: { chat?: { id?: number | string }; text?: string } };
      try {
        u = JSON.parse(rawBody);
      } catch {
        return { kind: "ignore", reason: "malformed JSON" };
      }
      const msg = u.message;
      if (!msg || typeof msg.text !== "string" || msg.text === "" || msg.chat?.id === undefined) {
        return { kind: "ignore", reason: "not a text message" };
      }
      return { kind: "message", conversationId: String(msg.chat.id), text: msg.text };
    },
    formatReply(reply) {
      // conversationId is the chat id we parsed; echo it back as chat_id.
      return { method: "sendMessage", chat_id: reply.conversationId, text: `(${reply.status}) ${JSON.stringify(reply.output)}` };
    },
  };
}

/** Convenience: a ready-to-serve Telegram bridge over an Iris REST channel. */
export function makeTelegramBridge(opts: {
  baseUrl: string;
  secretToken: string;
  fetchImpl?: typeof fetch;
}): PlatformBridge<TelegramReply> {
  return makePlatformBridge(telegramAdapter({ secretToken: opts.secretToken }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}

/** Forkless entry for `iris bridge`: reads the webhook secret token from the environment
 *  (`TELEGRAM_SECRET_TOKEN`). Imports only @irisrun/bridge — the import-discipline holds. */
export const openBridge: OpenBridge = (o) =>
  telegramAdapter({ secretToken: (o?.env ?? process.env).TELEGRAM_SECRET_TOKEN ?? "" });
