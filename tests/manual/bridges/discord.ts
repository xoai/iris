// Discord reference bridge (roadmap v0.2 §12). A thin adapter over the generic
// REST-protocol bridge — Discord Interactions in, an interaction response out. Auth is
// Ed25519 over `timestamp + rawBody` against the app's public key (Discord's required
// scheme). Zero @irisrun imports — only node:crypto + the shared harness.
import { createPublicKey, verify as edVerify } from "node:crypto";
import { makePlatformBridge, type PlatformAdapter, type PlatformBridge } from "../platform-bridge.ts";

// Discord interaction response body (the bridge replies in the HTTP response).
type DiscordReply = { type: number; data?: { content: string } };

// Ed25519 public keys are 32 raw bytes; Discord gives a hex string. Wrap with the fixed
// SPKI DER header to build a KeyObject (empirically: 302a300506032b6570032100 + 32 bytes).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromHex(hex: string): ReturnType<typeof createPublicKey> | null {
  try {
    const raw = Buffer.from(hex, "hex");
    if (raw.length !== 32) return null;
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export function discordAdapter(opts: { publicKeyHex: string }): PlatformAdapter<DiscordReply> {
  const key = publicKeyFromHex(opts.publicKeyHex);
  return {
    name: "discord",
    verify(headers, rawBody) {
      if (!key) return false;
      const sig = headers["x-signature-ed25519"];
      const ts = headers["x-signature-timestamp"];
      if (typeof sig !== "string" || typeof ts !== "string") return false;
      // Buffer.from(_, "hex") never throws (it silently drops non-hex chars), so the
      // length guard below — NOT a try/catch — is what rejects a non-hex/short sig.
      const sigBytes = Buffer.from(sig, "hex");
      if (sigBytes.length !== 64) return false; // an ed25519 sig is 64 bytes
      try {
        return edVerify(null, Buffer.from(ts + rawBody, "utf8"), key, sigBytes);
      } catch {
        return false;
      }
    },
    parse(rawBody) {
      let p: {
        type?: number;
        channel_id?: string;
        data?: { name?: string; options?: Array<{ value?: unknown }> };
      };
      try {
        p = JSON.parse(rawBody);
      } catch {
        return { kind: "ignore", reason: "malformed JSON" };
      }
      // type 1 = PING → must answer PONG (type 1); no turn.
      if (p.type === 1) return { kind: "handshake", response: { type: 1 } };
      // type 2 = APPLICATION_COMMAND (slash command).
      if (p.type === 2) {
        const text = String(p.data?.options?.[0]?.value ?? p.data?.name ?? "");
        return { kind: "message", conversationId: p.channel_id ?? "discord", text };
      }
      return { kind: "ignore", reason: `unhandled interaction type ${p.type}` };
    },
    formatReply(reply) {
      // type 4 = CHANNEL_MESSAGE_WITH_SOURCE
      return { type: 4, data: { content: `(${reply.status}) ${JSON.stringify(reply.output)}` } };
    },
  };
}

/** Convenience: a ready-to-serve Discord bridge over an Iris REST channel. */
export function makeDiscordBridge(opts: {
  baseUrl: string;
  publicKeyHex: string;
  fetchImpl?: typeof fetch;
}): PlatformBridge<DiscordReply> {
  return makePlatformBridge(discordAdapter({ publicKeyHex: opts.publicKeyHex }), {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
}
