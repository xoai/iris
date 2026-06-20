// T5 (HEADLINE) — governance end-to-end through runTurn, mirroring harness-hitl.test.ts
// but with the governed signal_recv performer. Proves BOTH:
//   #1 who-may-approve is policy-configurable — hold principal+intent+action constant
//      and vary ONLY the policy: A grants → tool runs; B denies → tool skipped.
//   #2 approvals are queryable from the journal — auditApprovals projects the trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  harnessProgram,
  acquireLease,
  encode,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Performer,
  Json,
  Version,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import {
  createApprovalInbox,
  makeGovernedApprovalPerformer,
  auditApprovals,
  approvalAudit,
} from "@irisrun/auth";
import type { ApprovalPolicy, GovernedAction, RawApproval } from "@irisrun/auth";
import { inspectSession } from "@irisrun/inspect";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
const RM: GovernedAction = { name: "rm", callId: "a" };
const ALICE_APPROVE: RawApproval = { principal: { id: "alice", roles: ["dev"] }, intent: "approve" };

type DepsOpts = { snapshotThreshold?: number; keepHistory?: boolean };

// Same shape as harness-hitl.test.ts's deps(), with `signal` = the governed performer.
function deps(store: MemoryStateStore, model: Performer, tool: Performer, signal: Performer, o: DepsOpts = {}): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
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
            return "ask"; // force the HITL approval path
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
    ...(o.snapshotThreshold !== undefined ? { snapshotThreshold: o.snapshotThreshold } : {}),
    ...(o.keepHistory !== undefined ? { keepHistory: o.keepHistory } : {}),
  };
}

// Run a full park→submit→resume cycle under `policy`, returning whether the tool ran.
async function runUnderPolicy(policy: ApprovalPolicy, decision: RawApproval, o: DepsOpts = {}): Promise<{ toolRan: boolean; store: MemoryStateStore }> {
  const store = new MemoryStateStore();
  const inbox = createApprovalInbox();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const signal = makeGovernedApprovalPerformer({ policy, inbox });

  const t1 = await runTurn(deps(store, model, tool, signal, o), "s");
  assert.equal(t1.status, "parked");
  assert.deepEqual(t1.status === "parked" ? t1.wait : null, { kind: "signal", name: "hitl:a" });

  inbox.submit(RM, decision); // the channel/UI records the decision before signalling resume
  const t2 = await runTurn(deps(store, model, tool, signal, o), "s");
  assert.equal(t2.status, "finished");
  return { toolRan: log.calls.length === 1, store };
}

const GRANTS_DEV: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["dev"] }] };
const REQUIRES_ADMIN: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["admin"] }] };

test("policy A (grants dev) runs the tool — identical inputs", async () => {
  const { toolRan } = await runUnderPolicy(GRANTS_DEV, ALICE_APPROVE);
  assert.equal(toolRan, true, "authorized approval runs the gated tool");
});

test("policy B (requires admin) SKIPS the tool — only the policy changed", async () => {
  const { toolRan } = await runUnderPolicy(REQUIRES_ADMIN, ALICE_APPROVE);
  assert.equal(toolRan, false, "same principal+intent+action, deny policy → tool skipped");
});

test("an explicit deny skips the tool even under a granting policy", async () => {
  const { toolRan } = await runUnderPolicy(GRANTS_DEV, { principal: { id: "alice", roles: ["dev"] }, intent: "deny" });
  assert.equal(toolRan, false);
});

test("the approval is queryable from the journal as an audit trail", async () => {
  const { store } = await runUnderPolicy(GRANTS_DEV, ALICE_APPROVE);
  const trail = await auditApprovals(store, "s");
  assert.equal(trail.length, 1);
  const e = trail[0];
  assert.equal(e.callId, "a");
  assert.equal(e.tool, "rm");
  assert.deepEqual(e.principal, { id: "alice", roles: ["dev"] });
  assert.equal(e.intent, "approve");
  assert.equal(e.approved, true);
  assert.equal(e.authorized, true);
});

test("recovery: a dangling signal_recv intent re-performs once; the approval does not flip", async () => {
  const store = new MemoryStateStore();
  const inbox = createApprovalInbox();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }), log);
  const signal = makeGovernedApprovalPerformer({ policy: GRANTS_DEV, inbox });

  const t1 = await runTurn(deps(store, model, tool, signal), "s");
  assert.equal(t1.status, "parked");
  inbox.submit(RM, ALICE_APPROVE);

  // Simulate a crash AFTER the signal_recv intent was written but before its result
  // (mirrors harness-hitl.test.ts:116). The idempotent inbox.get must not flip.
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  const rows = await store.readJournal("s", 0);
  const intentSeq = rows[rows.length - 1].seq + 1;
  const intent: JournalRecord = {
    seq: intentSeq,
    ts: 0,
    defDigest: "d",
    kind: "effect_intent",
    payload: { effectId: `signal_recv:${intentSeq}`, effectKind: "signal_recv", request: { name: "hitl:a" }, retrySafe: false },
  };
  const appended = await store.append("s", intentSeq, [encode(intent as unknown as Json)], fence);
  assert.ok(appended.ok, "setup append failed");

  const t2 = await runTurn(deps(store, model, tool, signal), "s");
  assert.equal(t2.status, "finished");
  assert.equal(log.calls.length, 1, "the approved tool runs exactly once after recovery (approval did not flip)");

  // The recovery re-perform must not DOUBLE-COUNT the approval in the audit either.
  const trail = await auditApprovals(store, "s");
  assert.equal(trail.length, 1, "exactly one approval entry after recovery (no double-count)");
});

// Regression: the audit must stay complete across a snapshot boundary. inspectSession
// reads only the post-snapshot tail, so auditApprovals reads the FULL retained journal.
test("across a snapshot: with retained history the trail is complete (auditApprovals ⊇ inspect tail)", async () => {
  const { store } = await runUnderPolicy(GRANTS_DEV, ALICE_APPROVE, { snapshotThreshold: 2, keepHistory: true });
  const insp = await inspectSession(store, "s");
  assert.notEqual(insp.snapshotUpTo, null, "a snapshot boundary was crossed (test is exercising the limitation)");

  const full = await auditApprovals(store, "s"); // reads the full retained journal from seq 0
  const tailOnly = approvalAudit(insp); // reads only the post-snapshot tail
  assert.equal(full.length, 1, "retained history → the approval is queryable across the snapshot");
  assert.equal(full[0].approved, true);
  assert.ok(full.length >= tailOnly.length, "the full-journal audit is at least as complete as the inspect tail");
});

test("retention limitation: a truncated session (no keepHistory) drops the pre-snapshot approval (documented)", async () => {
  const { store } = await runUnderPolicy(GRANTS_DEV, ALICE_APPROVE, { snapshotThreshold: 2 }); // default: truncates
  const insp = await inspectSession(store, "s");
  assert.notEqual(insp.snapshotUpTo, null, "a snapshot+truncate boundary was crossed");
  // The signal_recv intent+result were truncated past the snapshot → the approval is
  // gone from the retained journal. This is the documented retention contract: a
  // complete compliance trail requires retained history (keepHistory).
  const trail = await auditApprovals(store, "s");
  assert.equal(trail.length, 0, "truncated approval is absent — completeness requires retained history");
});
