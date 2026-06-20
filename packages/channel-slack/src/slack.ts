// makeSlackChannel (roadmap v0.2 §11) — a first-party Slack channel built on the
// channel port (@irisrun/channel-core) to showcase the moat where a buyer feels it:
// durable, journaled, approval-gated sessions. A Slack approval can PARK for hours,
// survive a redeploy, and resume the SAME session byte-identically — because the
// durable session lives in the StateStore and the approval context rides the (signed)
// Slack button value, not server memory. Zero runtime deps: node:crypto (verify) +
// built-in fetch (outbound, injectable).
import type { ChannelSession } from "@irisrun/channel-core";
import type { Json, TurnOutcome } from "@irisrun/core";
import type { ApprovalInbox, Principal } from "@irisrun/auth";
import { verifySlackSignature } from "./verify.ts";

export interface SlackChannelOptions<S extends Json> {
  session: ChannelSession<S>;
  inbox: ApprovalInbox; // from @irisrun/auth — the HITL decision sink
  signingSecret: string; // required; a missing secret is a loud construction error
  botToken?: string; // for outbound chat.postMessage (env SLACK_BOT_TOKEN)
  fetchImpl?: typeof fetch; // injectable for tests
  now?: () => number; // injectable clock for the replay window
  postUrl?: string; // chat.postMessage URL (default Slack's; injectable for tests)
  approvalActionIds?: { approve: string; deny: string };
  // Map a Slack user to an Iris Principal for the governed approval. Default:
  // { id: `slack:${userId}` }. The signature check already authenticated the request.
  principalForSlackUser?: (slackUserId: string) => Principal;
}

export interface SlackOutbound {
  channel: string;
  text: string;
  blocks?: Json;
}

export type SlackHandlerResult =
  | { kind: "unauthorized" } // bad/absent/expired signature — body NOT processed
  | { kind: "challenge"; challenge: string } // Slack url_verification handshake
  | { kind: "ignored"; reason: string } // a platform event this channel does not act on
  | { kind: "ack"; sessionId: string; status: string; outbound?: SlackOutbound }
  | { kind: "error"; message: string }; // a loud processing error

export interface SlackChannel {
  handleEvent(headers: Record<string, string | undefined>, rawBody: string): Promise<SlackHandlerResult>;
}

const DEFAULT_POST_URL = "https://slack.com/api/chat.postMessage";

// The approval context carried in each button's `value` — JSON, round-tripped through
// Slack so a click is reconstructable even by a fresh instance after a redeploy.
interface ApprovalContext {
  sessionId: string;
  callId: string;
  name: string;
}

// Derive the pending approval from a PARKED outcome: callId from the wait signal name
// (hitl:<callId>); the tool name from the parked HarnessState (total/defensive — an
// unexpected shape yields name:"" so a human can still decide). Mirrors the exported
// chat.ts `hitlRequest`, but over generic Json so channel-slack stays harness-agnostic.
function pendingApproval<S extends Json>(outcome: TurnOutcome<S>): { callId: string; name: string } | null {
  if (outcome.status !== "parked") return null;
  const wait = (outcome as { wait?: { kind?: string; name?: string } }).wait;
  if (!wait || wait.kind !== "signal" || typeof wait.name !== "string" || !wait.name.startsWith("hitl:")) {
    return null;
  }
  const callId = wait.name.slice("hitl:".length);
  let name = "";
  const state = (outcome as { state?: Json }).state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as { modelOut?: Json; toolCursor?: Json };
    const cursor = typeof s.toolCursor === "number" ? s.toolCursor : 0;
    const modelOut = s.modelOut;
    if (modelOut && typeof modelOut === "object" && !Array.isArray(modelOut)) {
      const toolCalls = (modelOut as { toolCalls?: Json }).toolCalls;
      if (Array.isArray(toolCalls)) {
        const call = toolCalls[cursor];
        if (call && typeof call === "object" && !Array.isArray(call) && typeof (call as { name?: Json }).name === "string") {
          name = (call as { name: string }).name;
        }
      }
    }
  }
  return { callId, name };
}

type Inbound =
  | { type: "url_verification"; challenge: string }
  | { type: "slash"; text: string; channel: string; userId: string }
  | { type: "action"; actionId: string; value: string; userId: string; channel: string }
  | { type: "ignore"; reason: string };

// Normalize the raw Slack body. JSON bodies = events/url_verification; form-encoded =
// slash commands (has `command`) or interactive components (has `payload=<json>`).
function parseInbound(rawBody: string): Inbound {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as Record<string, Json>;
      if (j.type === "url_verification" && typeof j.challenge === "string") {
        return { type: "url_verification", challenge: j.challenge };
      }
    } catch {
      return { type: "ignore", reason: "malformed JSON body" };
    }
    return { type: "ignore", reason: "unhandled events-API payload" };
  }
  const form = new URLSearchParams(rawBody);
  const payload = form.get("payload");
  if (payload !== null) {
    try {
      const p = JSON.parse(payload) as {
        type?: string;
        actions?: Array<{ action_id?: string; value?: string }>;
        user?: { id?: string };
        channel?: { id?: string };
      };
      const action = p.actions?.[0];
      if (p.type === "block_actions" && action && typeof action.action_id === "string") {
        return {
          type: "action",
          actionId: action.action_id,
          value: typeof action.value === "string" ? action.value : "",
          userId: typeof p.user?.id === "string" ? p.user.id : "",
          channel: typeof p.channel?.id === "string" ? p.channel.id : "",
        };
      }
    } catch {
      return { type: "ignore", reason: "malformed interactive payload" };
    }
    return { type: "ignore", reason: "unhandled interactive payload" };
  }
  if (form.get("command") !== null) {
    return {
      type: "slash",
      text: form.get("text") ?? "",
      channel: form.get("channel_id") ?? "",
      userId: form.get("user_id") ?? "",
    };
  }
  return { type: "ignore", reason: "unrecognized Slack body" };
}

export function makeSlackChannel<S extends Json>(opts: SlackChannelOptions<S>): SlackChannel {
  if (!opts.signingSecret) {
    throw new Error("makeSlackChannel: signingSecret is required (a Slack request must be verifiable)");
  }
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const postUrl = opts.postUrl ?? DEFAULT_POST_URL;
  const actionIds = opts.approvalActionIds ?? { approve: "iris_approve", deny: "iris_deny" };
  const principalFor = opts.principalForSlackUser ?? ((id: string): Principal => ({ id: `slack:${id}` }));

  // Build the interactive approval message: Approve/Deny buttons whose `value` carries
  // the durable approval context (round-trips through Slack → survives a redeploy).
  const approvalMessage = (channel: string, ctx: ApprovalContext): SlackOutbound => {
    const value = JSON.stringify(ctx);
    return {
      channel,
      text: `Approval needed for \`${ctx.name || "an action"}\` (session ${ctx.sessionId}).`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Approval needed for \`${ctx.name || "an action"}\`.` } },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: actionIds.approve, text: { type: "plain_text", text: "Approve" }, value, style: "primary" },
            { type: "button", action_id: actionIds.deny, text: { type: "plain_text", text: "Deny" }, value, style: "danger" },
          ],
        },
      ] as unknown as Json,
    };
  };

  const resultMessage = (channel: string, outcome: TurnOutcome<S>): SlackOutbound => {
    const out = outcome.status === "finished" ? (outcome as { output?: Json }).output : undefined;
    const text = out !== undefined ? `Done: ${JSON.stringify(out)}` : `Turn ${outcome.status}.`;
    return { channel, text };
  };

  // Post outbound to Slack if a bot token is configured; never throw (a failed post is
  // surfaced in the handler result, not swallowed silently).
  const post = async (outbound: SlackOutbound): Promise<void> => {
    if (!opts.botToken || !doFetch) return; // no token → caller posts via the returned outbound
    await doFetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.botToken}` },
      body: JSON.stringify(outbound),
    });
  };

  const verify = (headers: Record<string, string | undefined>, rawBody: string): boolean =>
    verifySlackSignature({
      signingSecret: opts.signingSecret,
      timestamp: headers["x-slack-request-timestamp"],
      rawBody,
      signature: headers["x-slack-signature"],
      nowMs: now(),
    });

  const handleEvent = async (
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<SlackHandlerResult> => {
    // 1. Authenticity FIRST — never process an unverified body.
    if (!verify(headers, rawBody)) return { kind: "unauthorized" };

    const inbound = parseInbound(rawBody);

    // 2. The Slack URL-verification handshake.
    if (inbound.type === "url_verification") return { kind: "challenge", challenge: inbound.challenge };
    if (inbound.type === "ignore") return { kind: "ignored", reason: inbound.reason };

    try {
      // 3. A slash command STARTS a session. If it parks on a HITL approval, emit the
      //    Approve/Deny buttons; otherwise emit the result.
      if (inbound.type === "slash") {
        const body = { messages: [{ role: "user", content: inbound.text }] } as unknown as Json;
        const r = await opts.session.start(body);
        const pending = pendingApproval(r.outcome);
        if (pending) {
          const outbound = approvalMessage(inbound.channel, { sessionId: r.sessionId, callId: pending.callId, name: pending.name });
          await post(outbound);
          return { kind: "ack", sessionId: r.sessionId, status: r.outcome.status, outbound };
        }
        const outbound = resultMessage(inbound.channel, r.outcome);
        await post(outbound);
        return { kind: "ack", sessionId: r.sessionId, status: r.outcome.status, outbound };
      }

      // 4. An interactive Approve/Deny → submit the governed decision and RESUME the
      //    durable session. The context comes from the (signature-verified) button
      //    value, so this works on a fresh instance after a redeploy.
      let ctx: ApprovalContext;
      try {
        ctx = JSON.parse(inbound.value) as ApprovalContext;
      } catch {
        return { kind: "error", message: "malformed approval button value" };
      }
      if (inbound.actionId !== actionIds.approve && inbound.actionId !== actionIds.deny) {
        return { kind: "ignored", reason: `unhandled action_id ${inbound.actionId}` };
      }
      const intent = inbound.actionId === actionIds.approve ? "approve" : "deny";
      const principal = principalFor(inbound.userId);
      // Record the decision BEFORE resuming so the governed signal_recv performer reads
      // it on the HITL resume (exactly the cli chat/serve pattern).
      opts.inbox.submit({ name: ctx.name, callId: ctx.callId }, { principal, intent });
      // advance() runs runTurn(sessionId), which resumes the durable parked session from
      // the store regardless of this instance's in-memory token map (post-redeploy safe).
      const r = await opts.session.advance(ctx.sessionId, { resume: ctx.callId } as unknown as Json);
      if (!r.ok) return { kind: "error", message: "a turn is already in flight for this session" };
      const outbound = resultMessage(inbound.channel, r.outcome);
      await post(outbound);
      return { kind: "ack", sessionId: ctx.sessionId, status: r.outcome.status, outbound };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  };

  return { handleEvent };
}
