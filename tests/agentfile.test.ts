import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentfileJson,
  validateAgentfile,
  contentPaths,
  contractRefs,
} from "@irisrun/agent";

const VALID = {
  apiVersion: "iris/v1",
  kind: "Agent",
  name: "support-triage",
  model: "anthropic/claude-x",
  instructions: "./instructions.md",
  skills: ["./skills/refunds.md", "./skills/escalation.md"],
  tools: [
    { ref: "mcp://registry/issue-tracker@^2" },
    { ref: "subprocess://./tools/csv-stats" },
  ],
  connections: [{ ref: "mcp://connect/github" }],
  harness: { bundle: "default" },
  requires: { long_running: true, local_subprocess: true, tool_locality: "local" },
  sandbox: { backend: "docker", workspace: "./workspace", network: "deny-all" },
};

test("T1: a valid Agentfile parses + validates", () => {
  const m = parseAgentfileJson(JSON.stringify(VALID));
  assert.equal(m.name, "support-triage");
  assert.equal(m.tools.length, 2);
  assert.equal(m.requires.tool_locality, "local");
});

test("T1: content vs contract classification", () => {
  const m = validateAgentfile(VALID);
  assert.deepEqual(contentPaths(m), [
    "./instructions.md",
    "./skills/refunds.md",
    "./skills/escalation.md",
    "./workspace",
  ]);
  assert.deepEqual(
    contractRefs(m).map((r) => r.ref),
    [
      "mcp://registry/issue-tracker@^2",
      "subprocess://./tools/csv-stats",
      "mcp://connect/github",
    ],
  );
});

test("T1: a tool entry with an inline-behavior field is rejected (ADR-0005)", () => {
  const bad = { ...VALID, tools: [{ ref: "subprocess://x", code: "print(1)" }] };
  assert.throws(() => validateAgentfile(bad), /inline|behavior/i);
});

test("T1: a tool ref with an unrecognized scheme is rejected", () => {
  const bad = { ...VALID, tools: [{ ref: "http://evil/tool" }] };
  assert.throws(() => validateAgentfile(bad), /scheme/i);
});

test("T1: a subprocess://<path> handle is accepted (built artifact, not source)", () => {
  const ok = { ...VALID, tools: [{ ref: "subprocess://./tools/csv-stats" }] };
  const m = validateAgentfile(ok);
  assert.equal(m.tools[0].ref, "subprocess://./tools/csv-stats");
});

test("T1: invalid JSON and missing required fields throw loudly", () => {
  assert.throws(() => parseAgentfileJson("{not json"), /invalid JSON/i);
  assert.throws(() => validateAgentfile({ kind: "Agent" }), /apiVersion|name|model|required|missing/i);
});

// --- T2: requires.* / harness.bundle / sandbox.workspace hardening ---------
// These present-but-wrong-typed optional fields were previously SILENTLY DROPPED
// or untyped; they now throw so the runtime agrees with the published JSON
// schema (initiative 20260620-agentfile-schema). Absent fields stay valid; a
// well-typed value behaves exactly as before (so existing image digests are
// unchanged).

test("T2: a typo'd requires.tool_locality is rejected", () => {
  const bad = { ...VALID, requires: { ...VALID.requires, tool_locality: "in_process" } };
  assert.throws(() => validateAgentfile(bad), /tool_locality/i);
});

test("T2: each valid requires.tool_locality enum value is accepted", () => {
  for (const tl of ["in-process", "local", "remote"]) {
    const ok = { ...VALID, requires: { ...VALID.requires, tool_locality: tl } };
    assert.equal(validateAgentfile(ok).requires.tool_locality, tl);
  }
});

test("T2: a non-boolean requires capability is rejected", () => {
  const bad = { ...VALID, requires: { ...VALID.requires, long_running: "yes" } };
  assert.throws(() => validateAgentfile(bad), /long_running|boolean/i);
});

test("T2: a non-string harness.bundle is rejected (was silently dropped)", () => {
  const bad = { ...VALID, harness: { bundle: 7 } };
  assert.throws(() => validateAgentfile(bad), /harness\.bundle|bundle/i);
});

test("T2: a non-string sandbox.workspace is rejected (was silently dropped)", () => {
  const bad = { ...VALID, sandbox: { ...VALID.sandbox, workspace: 9 } };
  assert.throws(() => validateAgentfile(bad), /workspace/i);
});

test("T2: absent optional fields remain valid (no over-strictness)", () => {
  const ok = { ...VALID, harness: {}, requires: {}, sandbox: { backend: "docker", network: "deny-all" } };
  const m = validateAgentfile(ok);
  assert.equal(m.sandbox.workspace, undefined);
  assert.equal(m.harness.bundle, undefined);
});
