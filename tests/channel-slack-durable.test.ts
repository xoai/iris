// THE §11 HEADLINE (roadmap v0.2 §11, plan T11.3): a Slack approval that PARKS, then —
// after the engine/channel/inbox are discarded and the store reopened (a simulated
// redeploy) — RESUMES the SAME session byte-identically when the Approve arrives. The
// durable session lives in the StateStore journal; the approval context rides the
// signed Slack button value, so a fresh instance with an empty map still resumes.
//
// Proven in-env against a REAL fs store (the chaos-suite redeploy pattern). The
// real-Slack-workspace public demo is the documented operator step (residual).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  runTurn as coreRunTurn,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@irisrun/core";
import type {
  EngineDeps,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Performer,
  Json,
  TurnOutcome,
  JournalRow,
} from "@irisrun/core";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { createApprovalInbox, makeGovernedApprovalPerformer, auditApprovals } from "@irisrun/auth";
import type { ApprovalPolicy, Principal } from "@irisrun/auth";
import { makeChannelSession } from "@irisrun/channel-core";
import { makeSlackChannel } from "@irisrun/channel-slack";

const SECRET = "slack-signing-secret";
const NOW_MS = 1_700_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));
function sign(rawBody: string): string {
  return `v0=${createHmac("sha256", SECRET).update(`v0:${TS}:${rawBody}`).digest("hex")}`;
}
function headers(rawBody: string): Record<string, string> {
  return { "x-slack-signature": sign(rawBody), "x-slack-request-timestamp": TS };
}

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
const GRANTS_DEV: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["dev"] }] };
const SESSION_ID = "slack-sess";

// Same deps shape as auth-governance-integration.test.ts: gateAction "ask" → HITL.
function deps(store: FsStateStore, model: Performer, tool: Performer, signal: Performer): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new FsScheduler({ root: (store as unknown as { root?: string }).root ?? "" }),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact":
            return false;
          case "gateAction":
            return "ask";
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: model,
      tool_call: tool,
      signal_recv: signal,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

// Build a Slack channel over a given store + inbox. The model/tool are external
// "services" shared across the redeploy (only the store + engine + channel + inbox are
// torn down — exactly what a redeploy tears down). principalForSlackUser grants role
// "dev" so the GRANTS_DEV policy authorizes the approval.
function buildChannel(store: FsStateStore, inbox: ReturnType<typeof createApprovalInbox>, model: Performer, tool: Performer) {
  const signal = makeGovernedApprovalPerformer({ policy: GRANTS_DEV, inbox });
  let t = 0;
  const session = makeChannelSession<Json>({
    runTurn: async (sessionId) =>
      (await coreRunTurn(deps(store, model, tool, signal), sessionId)) as unknown as TurnOutcome<Json>,
    mintSessionId: () => SESSION_ID,
    mintToken: () => `tok-${t++}`,
  });
  const principalForSlackUser = (id: string): Principal => ({ id: `slack:${id}`, roles: ["dev"] });
  return makeSlackChannel<Json>({ session, inbox, signingSecret: SECRET, now: () => NOW_MS, principalForSlackUser });
}

function approveButtonValue(outboundBlocks: unknown): string {
  const blocks = outboundBlocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
  const actions = blocks.find((b) => b.type === "actions");
  return actions!.elements!.find((e) => e.action_id === "iris_approve")!.value;
}

async function runScenario(
  redeploy: boolean,
): Promise<{ toolRan: boolean; finalStatus: string; journal: JournalRow[]; root: string; freshInboxGotSubmit: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "iris-slack-"));
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE); // shared external service across the redeploy
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);

  // PHASE 1 — a slash command starts the session; the agent parks on the rm approval.
  let store = new FsStateStore({ root });
  let inbox = createApprovalInbox();
  let ch = buildChannel(store, inbox, model, tool);
  const slash = "command=/iris&text=deploy&channel_id=C1&user_id=U1";
  const started = await ch.handleEvent(headers(slash), slash);
  assert.equal(started.kind, "ack", `slash should ack (got ${JSON.stringify(started)})`);
  assert.ok(started.kind === "ack" && started.status === "parked", "the session parked on the approval");
  const ctxValue = approveButtonValue(started.kind === "ack" ? started.outbound?.blocks : undefined);

  // SIMULATED REDEPLOY — discard the channel/session/inbox + the store handle; reopen
  // the store over the SAME on-disk data with a FRESH (empty) inbox + channel.
  if (redeploy) {
    store = new FsStateStore({ root });
    inbox = createApprovalInbox();
    ch = buildChannel(store, inbox, model, tool);
  }

  // PHASE 2 — the Approve interaction (its button value carries {sessionId,callId,name})
  // resumes the durable session even on the fresh instance.
  const payload = JSON.stringify({
    type: "block_actions",
    actions: [{ action_id: "iris_approve", value: ctxValue }],
    user: { id: "admin" },
    channel: { id: "C1" },
  });
  const rawBody = `payload=${encodeURIComponent(payload)}`;
  const resumed = await ch.handleEvent(headers(rawBody), rawBody);
  assert.equal(resumed.kind, "ack", `approve should ack (got ${JSON.stringify(resumed)})`);

  const journal = await store.readJournal(SESSION_ID, 0);
  return {
    toolRan: log.calls.length === 1,
    finalStatus: resumed.kind === "ack" ? resumed.status : "?",
    journal,
    root,
    // The decision must have landed in the CURRENT (post-redeploy, fresh) inbox — proof
    // the resume genuinely went through the new instance's components, not leftover state.
    freshInboxGotSubmit: inbox.get("a") !== undefined,
  };
}

test("§11 durable HITL: an Approve that survives a redeploy resumes the SAME session and runs the gated tool", async () => {
  const r = await runScenario(true);
  assert.equal(r.finalStatus, "finished", "the redeployed instance resumed the parked session to completion");
  assert.equal(r.toolRan, true, "the approved tool ran after the redeploy");
  assert.equal(r.freshInboxGotSubmit, true, "the FRESH post-redeploy inbox received the decision (resume used the new instance)");
  // the approval is in the durable journal (queryable audit trail), authorized
  const store = new FsStateStore({ root: r.root });
  const trail = await auditApprovals(store, SESSION_ID);
  assert.equal(trail.length, 1, "exactly one approval in the durable journal");
  assert.equal(trail[0].approved, true);
  assert.equal(trail[0].authorized, true);
  assert.equal(trail[0].tool, "rm");
});

test("§11 durable HITL: a DUPLICATE Approve (Slack retry) does not double-apply the gated tool", async () => {
  // Slack re-delivers an interaction on timeout. The Approve path calls session.advance
  // directly (token validation bypassed — the signature already authenticated it), so the
  // protection against double-apply is engine/store idempotency: the second advance
  // replays the finished journal and the recorded tool result, never re-running the tool.
  const root = mkdtempSync(join(tmpdir(), "iris-slack-dup-"));
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const store = new FsStateStore({ root });
  const inbox = createApprovalInbox();
  const ch = buildChannel(store, inbox, model, tool);

  const slash = "command=/iris&text=deploy&channel_id=C1&user_id=U1";
  const started = await ch.handleEvent(headers(slash), slash);
  const ctxValue = approveButtonValue(started.kind === "ack" ? started.outbound?.blocks : undefined);
  const payload = JSON.stringify({
    type: "block_actions",
    actions: [{ action_id: "iris_approve", value: ctxValue }],
    user: { id: "admin" },
    channel: { id: "C1" },
  });
  const rawBody = `payload=${encodeURIComponent(payload)}`;

  const first = await ch.handleEvent(headers(rawBody), rawBody);
  const second = await ch.handleEvent(headers(rawBody), rawBody); // the duplicate retry
  assert.ok(first.kind === "ack" && first.status === "finished", "first Approve finishes");
  assert.ok(second.kind === "ack" && second.status === "finished", "the duplicate Approve is again-safe (finished)");
  assert.equal(log.calls.length, 1, "the gated tool ran EXACTLY once despite the duplicate Approve");
});

test("§11 durable HITL: the redeployed resume is BYTE-IDENTICAL to a no-redeploy control", async () => {
  const control = await runScenario(false);
  const redeployed = await runScenario(true);
  assert.equal(control.finalStatus, "finished");
  assert.equal(redeployed.finalStatus, "finished");
  // The journals are produced by separate stores/dirs, but the records are produced by
  // the same program + scripted model + TestClock + tool, and the continuationToken is
  // NOT journaled (it is channel-instance-local) — so the durable session state is
  // byte-identical whether or not a redeploy happened mid-approval.
  assert.equal(redeployed.journal.length, control.journal.length, "same number of journal records");
  for (let i = 0; i < control.journal.length; i++) {
    assert.equal(redeployed.journal[i].seq, control.journal[i].seq, `seq ${i} matches`);
    assert.deepEqual(
      Buffer.from(redeployed.journal[i].bytes),
      Buffer.from(control.journal[i].bytes),
      `record ${i} is byte-identical across the redeploy`,
    );
  }
});
