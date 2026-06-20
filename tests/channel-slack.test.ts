// channel-slack unit + port conformance.
// Signature verification (constant-time, replay-windowed), the url_verification
// handshake, unverified-body refusal, slash→approval-buttons, and Approve→resume —
// all with an injected fetch/clock (no real Slack). The Slack channel's session is the
// shared channel-core session, so it also runs the §10 channel-port conformance suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Json, TurnOutcome } from "@irisrun/core";
import { makeChannelSession } from "@irisrun/channel-core";
import { createApprovalInbox, makeGovernedApprovalPerformer } from "@irisrun/auth";
import { makeSlackChannel, verifySlackSignature } from "@irisrun/channel-slack";
import { runChannelPortConformance, type ChannelOps } from "./lib/channel-port-conformance.ts";

const SECRET = "slack-signing-secret";
const NOW_MS = 1_700_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));

function sign(rawBody: string, ts = TS): string {
  return `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
}
function headers(rawBody: string, ts = TS): Record<string, string> {
  return { "x-slack-signature": sign(rawBody, ts), "x-slack-request-timestamp": ts };
}

// Minimal outcomes — the channel reads status + (for parked) wait/state.
function parkedOutcome(): TurnOutcome<Json> {
  return {
    status: "parked",
    wait: { kind: "signal", name: "hitl:c1" },
    state: { modelOut: { toolCalls: [{ name: "rm", callId: "c1", args: {} }] }, toolCursor: 0 },
  } as unknown as TurnOutcome<Json>;
}
function finishedOutcome(): TurnOutcome<Json> {
  return { status: "finished", output: { ran: true } } as unknown as TurnOutcome<Json>;
}

// A session whose first turn parks on a HITL approval and whose next turn finishes.
function parkThenFinishSession() {
  let calls = 0;
  let s = 0;
  let t = 0;
  return makeChannelSession<Json>({
    runTurn: async () => (++calls === 1 ? parkedOutcome() : finishedOutcome()),
    mintSessionId: () => `S${s++}`,
    mintToken: () => `T${t++}`,
  });
}

function captureFetch(captured: { calls: Array<{ url: string; body: unknown }> }): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    captured.calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
}

// ── signature verification ───────────────────────────────────────────────────

test("verify: a valid signature within the window passes", () => {
  const body = "command=/iris&text=hi";
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: TS, rawBody: body, signature: sign(body), nowMs: NOW_MS }), true);
});

test("verify: a wrong signature fails", () => {
  const body = "command=/iris&text=hi";
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: TS, rawBody: body, signature: "v0=deadbeef", nowMs: NOW_MS }), false);
});

test("verify: an expired timestamp fails even with a valid signature", () => {
  const body = "x=1";
  const oldTs = String(Math.floor(NOW_MS / 1000) - 600); // 10 minutes old
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: oldTs, rawBody: body, signature: sign(body, oldTs), nowMs: NOW_MS }), false);
});

test("verify: absent signature/timestamp fail closed (no throw)", () => {
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, rawBody: "x", signature: "v0=x", nowMs: NOW_MS }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: TS, rawBody: "x", signature: undefined, nowMs: NOW_MS }), false);
});

test("verify: a length-mismatched signature fails without throwing (timingSafeEqual guard)", () => {
  const body = "x=1";
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: TS, rawBody: body, signature: "v0=short", nowMs: NOW_MS }), false);
});

// ── construction ─────────────────────────────────────────────────────────────

test("makeSlackChannel: a missing signingSecret is a loud construction error", () => {
  assert.throws(
    () => makeSlackChannel({ session: parkThenFinishSession(), inbox: createApprovalInbox(), signingSecret: "" }),
    /signingSecret is required/,
  );
});

// ── handleEvent ──────────────────────────────────────────────────────────────

test("handleEvent: an unverified body is refused and NEVER processed", async () => {
  const ch = makeSlackChannel({ session: parkThenFinishSession(), inbox: createApprovalInbox(), signingSecret: SECRET, now: () => NOW_MS });
  const body = "command=/iris&text=hi&channel_id=C1&user_id=U1";
  const r = await ch.handleEvent({ "x-slack-signature": "v0=bogus", "x-slack-request-timestamp": TS }, body);
  assert.deepEqual(r, { kind: "unauthorized" });
});

test("handleEvent: url_verification echoes the challenge", async () => {
  const ch = makeSlackChannel({ session: parkThenFinishSession(), inbox: createApprovalInbox(), signingSecret: SECRET, now: () => NOW_MS });
  const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
  const r = await ch.handleEvent(headers(body), body);
  assert.deepEqual(r, { kind: "challenge", challenge: "chal-123" });
});

test("handleEvent: a slash command that parks emits Approve/Deny buttons carrying the context", async () => {
  const captured = { calls: [] as Array<{ url: string; body: unknown }> };
  const ch = makeSlackChannel({
    session: parkThenFinishSession(),
    inbox: createApprovalInbox(),
    signingSecret: SECRET,
    botToken: "xoxb-test",
    fetchImpl: captureFetch(captured),
    now: () => NOW_MS,
  });
  const body = "command=/iris&text=deploy&channel_id=C1&user_id=U1";
  const r = await ch.handleEvent(headers(body), body);
  assert.equal(r.kind, "ack");
  if (r.kind === "ack") {
    assert.equal(r.status, "parked");
    const blocks = r.outbound?.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
    const actions = blocks.find((b) => b.type === "actions");
    assert.ok(actions, "an actions block with buttons is emitted");
    const approve = actions!.elements!.find((e) => e.action_id === "iris_approve")!;
    const ctx = JSON.parse(approve.value) as { sessionId: string; callId: string; name: string };
    assert.equal(ctx.callId, "c1", "the button value carries the callId");
    assert.equal(ctx.name, "rm", "the button value carries the tool name (from the parked state)");
    assert.equal(ctx.sessionId, r.sessionId);
  }
  assert.equal(captured.calls.length, 1, "the approval message was posted via chat.postMessage");
  assert.match(captured.calls[0].url, /chat\.postMessage/);
});

test("handleEvent: an Approve action submits the governed decision and resumes the session", async () => {
  const inbox = createApprovalInbox();
  const ch = makeSlackChannel({ session: parkThenFinishSession(), inbox, signingSecret: SECRET, now: () => NOW_MS });
  // first, the slash command parks and gives us a sessionId
  const slash = "command=/iris&text=deploy&channel_id=C1&user_id=U1";
  const started = await ch.handleEvent(headers(slash), slash);
  assert.equal(started.kind, "ack");
  const sessionId = started.kind === "ack" ? started.sessionId : "";

  // the Approve button click round-trips the context value
  const ctx = JSON.stringify({ sessionId, callId: "c1", name: "rm" });
  const payload = JSON.stringify({ type: "block_actions", actions: [{ action_id: "iris_approve", value: ctx }], user: { id: "U-admin" }, channel: { id: "C1" } });
  const rawBody = `payload=${encodeURIComponent(payload)}`;
  const r = await ch.handleEvent(headers(rawBody), rawBody);

  assert.equal(r.kind, "ack", JSON.stringify(r));
  if (r.kind === "ack") assert.equal(r.status, "finished", "the session resumed and finished");
  // the decision reached the inbox with the principal derived from the Slack user
  const submitted = inbox.get("c1");
  assert.ok(submitted, "the approval was submitted to the inbox");
  assert.equal(submitted!.action.name, "rm");
  assert.equal(submitted!.decision.intent, "approve");
  assert.equal(submitted!.decision.principal.id, "slack:U-admin", "default principal mapping");
});

test("handleEvent: a Deny action submits intent=deny", async () => {
  const inbox = createApprovalInbox();
  const ch = makeSlackChannel({ session: parkThenFinishSession(), inbox, signingSecret: SECRET, now: () => NOW_MS });
  const slash = "command=/iris&text=deploy&channel_id=C1&user_id=U1";
  const started = await ch.handleEvent(headers(slash), slash);
  const sessionId = started.kind === "ack" ? started.sessionId : "";
  const ctx = JSON.stringify({ sessionId, callId: "c1", name: "rm" });
  const payload = JSON.stringify({ type: "block_actions", actions: [{ action_id: "iris_deny", value: ctx }], user: { id: "U2" }, channel: { id: "C1" } });
  const rawBody = `payload=${encodeURIComponent(payload)}`;
  await ch.handleEvent(headers(rawBody), rawBody);
  assert.equal(inbox.get("c1")?.decision.intent, "deny");
});

// avoid an unused-import warning for the governed performer (used in the durable test)
void makeGovernedApprovalPerformer;

// ── the Slack channel's session passes the §10 channel-port conformance suite ──

runChannelPortConformance({
  name: "channel-slack-session",
  async create(): Promise<ChannelOps> {
    let next: "ok" | "contend" | "abort" = "ok";
    const outcomeFor = (m: "ok" | "contend" | "abort"): TurnOutcome<Json> => {
      if (m === "contend") return { status: "contended", current: 5 } as unknown as TurnOutcome<Json>;
      if (m === "abort") return { status: "aborted", reason: "lease_lost" } as unknown as TurnOutcome<Json>;
      return finishedOutcome();
    };
    let s = 0;
    let t = 0;
    const session = makeChannelSession<Json>({
      runTurn: async () => {
        const m = next;
        next = "ok";
        return outcomeFor(m);
      },
      mintSessionId: () => `cs-${s++}`,
      mintToken: () => `ct-${t++}`,
    });
    return {
      async start() {
        const r = await session.start({});
        return { sessionId: r.sessionId, token: r.token };
      },
      setNext: (m) => {
        next = m;
      },
      async continueTurn(sessionId, token) {
        const r = await session.continueTurn(sessionId, token, {});
        if (r.ok) return { ok: true, token: r.token, status: r.outcome.status };
        return { ok: false, refusal: r.reason };
      },
      close: async () => {},
    };
  },
});
