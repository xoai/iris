// P2-9 (C4) — childSessionId determinism. The deterministic id is what makes a recovery
// re-perform of a `subagent` effect idempotent (it re-finds the SAME child session).
import { test } from "node:test";
import assert from "node:assert/strict";
import { childSessionId } from "@iris/subagents";

test("childSessionId is deterministic: same (parent, callId) → same id", () => {
  assert.equal(childSessionId("parent-1", "a"), childSessionId("parent-1", "a"));
  assert.equal(childSessionId("parent-1", "a"), "parent-1::sub::a");
});

test("childSessionId is distinct per parent and per callId", () => {
  assert.notEqual(childSessionId("parent-1", "a"), childSessionId("parent-2", "a"));
  assert.notEqual(childSessionId("parent-1", "a"), childSessionId("parent-1", "b"));
});

test("childSessionId rejects empty inputs loudly (boundary guard)", () => {
  assert.throws(() => childSessionId("", "a"), /parentSessionId must be non-empty/);
  assert.throws(() => childSessionId("p", ""), /callId must be non-empty/);
});
