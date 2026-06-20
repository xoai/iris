// Slack request authenticity (roadmap v0.2 §11). Slack signs every request:
//   signature = "v0=" + HMAC_SHA256(signingSecret, `v0:${timestamp}:${rawBody}`)
// We verify it in CONSTANT time and reject stale timestamps (replay window). An
// unverified body is NEVER processed — the durable-HITL guarantee rests on the fact
// that an Approve interaction genuinely came from Slack. Zero deps: node:crypto only.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyInput {
  signingSecret: string;
  timestamp: string | undefined; // x-slack-request-timestamp (unix seconds, as a string)
  rawBody: string; // the EXACT raw request body (signature is over the bytes)
  signature: string | undefined; // x-slack-signature ("v0=...")
  nowMs: number; // injectable clock (for the replay window)
  maxSkewSeconds?: number; // default 300 (Slack's recommended 5 minutes)
}

/** True iff the signature is valid AND the timestamp is within the replay window.
 *  Loud false (never throws) on any malformed/absent/expired/mismatched input. */
export function verifySlackSignature(input: VerifyInput): boolean {
  const { signingSecret, timestamp, rawBody, signature, nowMs } = input;
  const maxSkew = input.maxSkewSeconds ?? 300;
  if (!signingSecret || !timestamp || !signature) return false;

  // Replay window: reject a timestamp too far from now (in either direction).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > maxSkew) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  // Constant-time compare — but timingSafeEqual throws on length mismatch, so guard
  // length first (a length mismatch is already a definitive non-match).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
