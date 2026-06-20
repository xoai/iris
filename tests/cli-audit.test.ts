// cmdAudit(): the `iris audit` command logic over an injected store.
// Asserts the rendered trail + verification line, the --json shape, an empty session,
// and the C1 interactivity auto-detection (an interactive session must replay under
// the interactive reducer — forcing the wrong reducer must fail). cli-main.ts's
// auditCommand (real sqlite IO) is not unit-tested per repo convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStateStore } from "@irisrun/store-memory";
import { cmdAudit } from "iris-runtime";
import { recordGovernedSession, recordInteractiveSession } from "./lib/record-governed-session.ts";

test("cmdAudit: non-interactive finished session → trail text + OK verify line", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 64 });
  const { audit, verify, text } = await cmdAudit({ store, sessionId: "s" });
  assert.equal(audit.terminal, "finished");
  assert.equal(audit.complete, true);
  assert.equal(verify.ok, true, `verify should pass: ${verify.issues.join("; ")}`);
  assert.match(text, /session s/);
  assert.match(text, /verify: OK/);
  assert.match(text, /alice/, "the governed approval appears in the trail");
});

test("cmdAudit: returns {audit, verify} of the right shape (for --json serialization)", async () => {
  const store = await recordGovernedSession({ snapshotThreshold: 64 });
  const { audit, verify } = await cmdAudit({ store, sessionId: "s" });
  assert.ok(Array.isArray(audit.records) && audit.records.length > 0);
  assert.equal(typeof verify.ok, "boolean");
  assert.ok(Array.isArray(verify.issues));
});

test("cmdAudit: empty/unknown session → valid empty audit, verify ok", async () => {
  const store = new MemoryStateStore();
  const { audit, verify, text } = await cmdAudit({ store, sessionId: "nope" });
  assert.equal(audit.records.length, 0);
  assert.equal(audit.complete, true);
  assert.equal(verify.ok, true);
  assert.match(text, /no approvals/i);
});

test("cmdAudit C1: interactive session auto-detected → total:true; forcing non-interactive → total:false", async () => {
  const store = await recordInteractiveSession();
  const auto = await cmdAudit({ store, sessionId: "s" });
  assert.equal(auto.audit.terminal, "parked");
  assert.equal(auto.verify.total, true, `interactive auto-detect must replay totally: ${auto.verify.issues.join("; ")}`);

  const forced = await cmdAudit({ store, sessionId: "s", interactive: false });
  assert.equal(forced.verify.total, false, "the wrong (non-interactive) reducer cannot replay an interactive journal");
  assert.equal(forced.verify.ok, false);
});
