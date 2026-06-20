// T6 — opt-in CLI wiring (zero-value-off). Two proofs:
//   • byte-identity: governancePerformers(undefined) === {} (no signal_recv key), so a
//     CLI run WITHOUT governance assembles the same registry as today;
//   • reachability: cmdRun WITH governance actually governs a HITL approval end-to-end
//     (an unauthorized "approve" is blocked by the policy → the gated tool is skipped),
//     and the decision is queryable from the journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdInit,
  cmdBuild,
  cmdRun,
  cmdServe,
  loadBundledTools,
  governancePerformers,
  loadApprovalPolicy,
  type ServeHandle,
} from "iris-runtime";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { createApprovalInbox, auditApprovals } from "@irisrun/auth";
import type { ApprovalPolicy, ApprovalInbox } from "@irisrun/auth";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));
const scaffoldResolver = async (src: string) => (await loadBundledTools(join(src, "tools"))).resolver;

test("byte-identity: governancePerformers(undefined) adds no signal_recv key", () => {
  assert.deepEqual(governancePerformers(undefined), {});
  assert.equal(Object.keys(governancePerformers(undefined)).length, 0);
});

test("governancePerformers({policy,inbox}) registers exactly a signal_recv performer", () => {
  const wired = governancePerformers({ policy: { rules: [] }, inbox: createApprovalInbox() });
  assert.deepEqual(Object.keys(wired), ["signal_recv"]);
  assert.equal(typeof wired.signal_recv, "function");
});

test("cmdRun with governance: an unauthorized approval is blocked by policy; tool skipped; journaled", async () => {
  const src = await tmp("iris-gov-src-");
  await cmdInit(src);
  const out = await tmp("iris-gov-out-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });

  const store = new MemoryStateStore();
  const inbox = createApprovalInbox();
  // Policy requires the "admin" role; the approver only has "dev" → unauthorized.
  const policy: ApprovalPolicy = { rules: [{ anyOfRoles: ["admin"] }] };

  // The model asks to call a (non-safe) tool, then finishes → the gate parks on hitl.
  const model = makeScriptedModel([
    { role: "assistant", content: "call", toolCalls: [{ callId: "k", name: "danger", args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ]);

  const t1 = await cmdRun(out, {
    sessionId: "s", store, scheduler: new MemoryScheduler(), clock: new TestClock(1),
    modelPerformer: model, governance: { policy, inbox },
  });
  assert.equal(t1.status, "parked", "gate 'ask' parks the turn for approval");

  // The channel/UI records the decision (a dev approving) before resuming.
  inbox.submit({ name: "danger", callId: "k" }, { principal: { id: "u", roles: ["dev"] }, intent: "approve" });
  const t2 = await cmdRun(out, {
    sessionId: "s", store, scheduler: new MemoryScheduler(), clock: new TestClock(2),
    modelPerformer: model, governance: { policy, inbox },
  });
  assert.equal(t2.status, "finished");

  // The journal yields the governed decision: blocked because the policy denied it.
  const trail = await auditApprovals(store, "s");
  assert.equal(trail.length, 1);
  assert.equal(trail[0].callId, "k");
  assert.equal(trail[0].approved, false, "unauthorized approval did not run the tool");
  assert.equal(trail[0].authorized, false);
  assert.deepEqual(trail[0].principal, { id: "u", roles: ["dev"] });
});

// --- C1: governance reachable from `iris serve --policy` ---------------------

// loadApprovalPolicy is the testable seam serveCommand uses to parse + validate the
// --policy file (cli-main.ts does the real readFile). It must reject malformed input
// LOUDLY — a bad policy must never silently fall back to ungoverned (policy widening).
test("loadApprovalPolicy: a well-formed policy parses; default permit/deny preserved", () => {
  const p = loadApprovalPolicy(JSON.stringify({ rules: [{ tool: "rm", anyOfRoles: ["admin"] }], default: "deny" }));
  assert.deepEqual(p.rules, [{ tool: "rm", anyOfRoles: ["admin"] }]);
  assert.equal(p.default, "deny");
  // an empty-rules policy is valid (deny-all by default)
  assert.deepEqual(loadApprovalPolicy(JSON.stringify({ rules: [] })).rules, []);
});

test("loadApprovalPolicy: malformed input fails LOUDLY (no silent ungoverned fallback)", () => {
  assert.throws(() => loadApprovalPolicy("not json{"), /policy/i);
  assert.throws(() => loadApprovalPolicy(JSON.stringify({ nope: 1 })), /rules/i);
  assert.throws(() => loadApprovalPolicy(JSON.stringify({ rules: "x" })), /rules/i);
  assert.throws(() => loadApprovalPolicy(JSON.stringify([])), /policy|object/i);
  assert.throws(() => loadApprovalPolicy(JSON.stringify({ rules: [], default: "maybe" })), /default/i);
});

// End-to-end over the in-process serve channel: the approval decision rides the
// continue-message BODY (`approve:{…}`), which cmdServe.makeTurnInputs submits to the
// shared inbox before the turn — so governance works with ZERO channel surgery.
async function serveGoverned(policy: ApprovalPolicy): Promise<{ serve: ServeHandle; store: MemoryStateStore; inbox: ApprovalInbox }> {
  const src = await tmp("iris-gserve-src-");
  await cmdInit(src);
  const out = await tmp("iris-gserve-out-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });

  const store = new MemoryStateStore();
  const inbox = createApprovalInbox();
  // ONE persistent scripted model instance (cmdServe calls makeModelPerformer per
  // turn; reusing the same instance keeps its index across the park→resume turns).
  const model = makeScriptedModel([
    { role: "assistant", content: "call", toolCalls: [{ callId: "k", name: "danger", args: {} }], stopReason: "tool_use" },
    { role: "assistant", content: "done", stopReason: "end_turn" },
  ]);
  const serve = await cmdServe(out, {
    store,
    scheduler: new MemoryScheduler(),
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer: () => model,
    port: 0,
    governance: { policy, inbox },
  });
  return { serve, store, inbox };
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
}

test("iris serve --policy: a gated tool parks; an approval submitted via the message body is journaled", async () => {
  // Policy requires admin; the approver is only a dev → unauthorized → tool skipped,
  // turn finishes. Proves the body.approve → inbox.submit wiring AND policy eval.
  const { serve, store } = await serveGoverned({ rules: [{ tool: "danger", anyOfRoles: ["admin"] }] });
  try {
    const j1 = await post(`${serve.url}/v1/session`, { messages: [{ role: "user", content: "go" }] });
    assert.equal(j1.status, "parked", "the gate parks the turn on the HITL approval");
    assert.deepEqual(j1.wait, { kind: "signal", name: "hitl:k" });

    const j2 = await post(`${serve.url}/v1/session/${String(j1.sessionId)}/message`, {
      continuationToken: j1.continuationToken,
      approve: { callId: "k", name: "danger", principal: { id: "u", roles: ["dev"] }, intent: "approve" },
    });
    assert.equal(j2.status, "finished", "unauthorized approval → tool skipped → finishes");

    const trail = await auditApprovals(store, String(j1.sessionId));
    assert.equal(trail.length, 1, "the approval is journaled (decision rode the message body)");
    assert.equal(trail[0].callId, "k");
    assert.equal(trail[0].approved, false, "unauthorized → not approved");
    assert.equal(trail[0].authorized, false);
    assert.deepEqual(trail[0].principal, { id: "u", roles: ["dev"] });
  } finally {
    await serve.close();
  }
});

test("iris serve --policy: an AUTHORIZED approval is journaled as approved+authorized (iris audit headline)", async () => {
  // Policy grants admin; the approver is an admin → approved + authorized. Assert on
  // the journaled trail (committed at recv_hitl, before tool dispatch) — robust.
  const { serve, store } = await serveGoverned({ rules: [{ tool: "danger", anyOfRoles: ["admin"] }] });
  try {
    const j1 = await post(`${serve.url}/v1/session`, { messages: [{ role: "user", content: "go" }] });
    assert.equal(j1.status, "parked");
    await post(`${serve.url}/v1/session/${String(j1.sessionId)}/message`, {
      continuationToken: j1.continuationToken,
      approve: { callId: "k", name: "danger", principal: { id: "alice", roles: ["admin"] }, intent: "approve" },
    });
    const trail = await auditApprovals(store, String(j1.sessionId));
    assert.equal(trail.length, 1);
    assert.equal(trail[0].approved, true, "authorized admin approval is honored");
    assert.equal(trail[0].authorized, true);
    assert.deepEqual(trail[0].principal, { id: "alice", roles: ["admin"] });
  } finally {
    await serve.close();
  }
});

test("iris serve WITHOUT governance: a stray `approve` body is ignored (byte-identical, no crash)", async () => {
  // Regression witness: cmdServe with no governance must behave exactly as today —
  // no signal_recv performer, no approval trail, a stray approve field is inert.
  const src = await tmp("iris-nogov-src-");
  await cmdInit(src);
  const out = await tmp("iris-nogov-out-");
  await cmdBuild({ file: join(src, "agent.json"), out, resolver: await scaffoldResolver(src) });
  const store = new MemoryStateStore();
  const serve = await cmdServe(out, {
    store,
    scheduler: new MemoryScheduler(),
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer: () => makeScriptedModel([{ role: "assistant", content: "hi", stopReason: "end_turn" }]),
    port: 0,
  });
  try {
    const j1 = await post(`${serve.url}/v1/session`, {
      messages: [{ role: "user", content: "go" }],
      approve: { callId: "x", name: "y", principal: { id: "z" }, intent: "approve" },
    });
    assert.equal(j1.status, "finished", "no governance → the stray approve field is inert");
    const trail = await auditApprovals(store, String(j1.sessionId));
    assert.equal(trail.length, 0, "ungoverned session journals no approvals");
  } finally {
    await serve.close();
  }
});
