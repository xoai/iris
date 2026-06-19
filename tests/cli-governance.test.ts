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
import { cmdInit, cmdBuild, cmdRun, loadBundledTools, governancePerformers } from "iris";
import { MemoryStateStore, MemoryScheduler } from "@iris/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { createApprovalInbox, auditApprovals } from "@iris/auth";
import type { ApprovalPolicy } from "@iris/auth";

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
