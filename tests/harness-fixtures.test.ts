// Task 2 (M2): the host-side performer fixtures the kernel will drive — a
// simulated in-process `tool_call` performer (real protocol-boundary tools are
// M3) and a `signal_recv` performer that returns a pre-arranged HITL approval.
// These assert the fixture CONTRACT (Json-shaped Outcome) the later harness
// tests rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";
import { makeFakeSignal } from "./lib/fake-signal.ts";

test("fake tool performer returns the scripted success outcome for a known tool", async () => {
  const log: ToolCallLog = { calls: [] };
  const tool = makeFakeTool(
    (call) => ({ ok: true, value: { echoed: call.args } }),
    log,
  );
  const out = await tool({ name: "search", args: { q: "iris" } });
  assert.deepEqual(out, { ok: true, value: { echoed: { q: "iris" } } });
  assert.deepEqual(log.calls, [{ name: "search", args: { q: "iris" } }]);
});

test("fake tool performer can script a failure outcome", async () => {
  const tool = makeFakeTool(() => ({
    ok: false,
    error: { message: "boom", code: "E_TOOL" },
  }));
  const out = await tool({ name: "broken", args: {} });
  assert.deepEqual(out, { ok: false, error: { message: "boom", code: "E_TOOL" } });
});

test("fake tool performer sequences outcomes by call index (fail then succeed)", async () => {
  const tool = makeFakeTool((_call, i) =>
    i === 0
      ? { ok: false, error: { message: "transient" } }
      : { ok: true, value: { done: true } },
  );
  const first = await tool({ name: "flaky", args: {} });
  const second = await tool({ name: "flaky", args: {} });
  assert.equal(first.ok, false);
  assert.deepEqual(second, { ok: true, value: { done: true } });
});

test("fake signal performer returns the arranged approval; deterministic across re-perform", async () => {
  const approve = makeFakeSignal(true);
  const a1 = await approve({ name: "hitl:c1" });
  const a2 = await approve({ name: "hitl:c1" }); // re-perform on recovery must not flip
  assert.deepEqual(a1, { ok: true, value: { approved: true } });
  assert.deepEqual(a2, a1);

  const deny = makeFakeSignal(false);
  const d1 = await deny({ name: "hitl:c2" });
  assert.deepEqual(d1, { ok: true, value: { approved: false } });
});
