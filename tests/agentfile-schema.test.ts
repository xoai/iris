import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTFILE_SCHEMA,
  agentfileSchemaJson,
  checkAgainstSchema,
  validateAgentfile,
} from "@irisrun/agent";

// A canonical valid Agentfile (mirrors tests/agentfile.test.ts VALID — kept
// local so this suite does not depend on the non-exported CLI SCAFFOLD_AGENT;
// the REAL scaffold is pinned against the schema in tests/cli.test.ts).
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

// --- T1: the schema document itself --------------------------------------

test("T1 schema: agentfileSchemaJson() is valid, pretty JSON of AGENTFILE_SCHEMA", () => {
  const text = agentfileSchemaJson();
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, AGENTFILE_SCHEMA, "JSON round-trips to the schema object");
  assert.ok(text.includes("\n  "), "pretty-printed (2-space indent)");
});

test("T1 schema: shape — $id, draft, root required, apiVersion/kind const", () => {
  const s = AGENTFILE_SCHEMA as Record<string, unknown>;
  assert.equal(s.$id, "https://iris.run/schema/agentfile/v1.json");
  assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(s.type, "object");
  const required = s.required as string[];
  for (const k of [
    "apiVersion",
    "kind",
    "name",
    "model",
    "instructions",
    "skills",
    "tools",
    "connections",
    "sandbox",
  ]) {
    assert.ok(required.includes(k), `root required includes "${k}"`);
  }
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.apiVersion.const, "iris/v1");
  assert.equal(props.kind.const, "Agent");
});

// --- T1: checkAgainstSchema accepts real Agentfiles ----------------------

test("T1 checker: a valid Agentfile yields no errors", () => {
  assert.deepEqual(checkAgainstSchema(VALID), []);
});

test("T1 checker: a top-level $schema key is accepted (editor metadata)", () => {
  assert.deepEqual(checkAgainstSchema({ $schema: "./agentfile.schema.json", ...VALID }), []);
});

// --- T1: checkAgainstSchema rejects each malformed shape -----------------

const REJECTS: Array<{ name: string; bad: unknown; match: RegExp }> = [
  { name: "wrong apiVersion", bad: { ...VALID, apiVersion: "iris/v2" }, match: /apiVersion/ },
  { name: "wrong kind", bad: { ...VALID, kind: "Robot" }, match: /kind/ },
  { name: "missing name", bad: omit(VALID, "name"), match: /name/ },
  { name: "empty model", bad: { ...VALID, model: "" }, match: /model/ },
  { name: "missing instructions", bad: omit(VALID, "instructions"), match: /instructions/ },
  { name: "skills not string[]", bad: { ...VALID, skills: [1, 2] }, match: /skills/ },
  { name: "tools not array", bad: { ...VALID, tools: {} }, match: /tools/ },
  { name: "tool missing ref", bad: { ...VALID, tools: [{}] }, match: /tools\[0\]\.ref/ },
  { name: "bad ref scheme", bad: { ...VALID, tools: [{ ref: "http://evil" }] }, match: /tools\[0\]\.ref/ },
  { name: "inline behavior (code)", bad: { ...VALID, tools: [{ ref: "subprocess://x", code: "y" }] }, match: /tools\[0\]\.code/ },
  { name: "inline behavior (script)", bad: { ...VALID, connections: [{ ref: "mcp://x", script: "y" }] }, match: /connections\[0\]\.script/ },
  { name: "bad tool_locality", bad: { ...VALID, requires: { tool_locality: "in_process" } }, match: /tool_locality/ },
  { name: "non-boolean cap", bad: { ...VALID, requires: { long_running: "yes" } }, match: /long_running/ },
  { name: "non-string harness.bundle", bad: { ...VALID, harness: { bundle: 7 } }, match: /harness\.bundle/ },
  { name: "non-object harness.tactics", bad: { ...VALID, harness: { tactics: "nope" } }, match: /harness\.tactics/ },
  // explicit JSON null for an optional object must REJECT on both sides (absent
  // is fine and defaults to {}, but `null` is wrong-typed — not "omitted").
  { name: "null harness", bad: { ...VALID, harness: null }, match: /harness/ },
  { name: "null requires", bad: { ...VALID, requires: null }, match: /requires/ },
  { name: "missing sandbox", bad: omit(VALID, "sandbox"), match: /sandbox/ },
  { name: "empty sandbox.backend", bad: { ...VALID, sandbox: { backend: "", network: "deny-all" } }, match: /sandbox\.backend/ },
  { name: "non-string sandbox.workspace", bad: { ...VALID, sandbox: { backend: "docker", network: "deny-all", workspace: 9 } }, match: /sandbox\.workspace/ },
];

for (const c of REJECTS) {
  test(`T1 checker: rejects ${c.name}`, () => {
    const errs = checkAgainstSchema(c.bad);
    assert.ok(errs.length > 0, `expected errors for ${c.name}`);
    assert.ok(
      errs.some((e) => c.match.test(e)),
      `expected an error matching ${c.match} for ${c.name}; got ${JSON.stringify(errs)}`,
    );
  });
}

// --- T1: pattern is compiled WITHOUT the `m` flag ------------------------
// A ref containing a newline must still be accepted (the runtime refScheme reads
// up to the first "://" from string-start; an `m` flag would let "^" match the
// post-newline line-start and wrongly validate a non-scheme second line — but it
// would also still accept here, so the discriminating case is the NEGATIVE one
// below: a non-scheme FIRST segment with a valid-looking SECOND line must reject.
test("T1 checker: scheme pattern is string-anchored (no `m` flag)", () => {
  // first line is a real scheme → accepted regardless of trailing newline content
  assert.deepEqual(checkAgainstSchema({ ...VALID, tools: [{ ref: "mcp://a\nmore" }] }), []);
  // first line is NOT a scheme, second line looks like one → must REJECT (an `m`
  // flag would match "^mcp://" on line 2 and wrongly accept).
  const errs = checkAgainstSchema({ ...VALID, tools: [{ ref: "x://a\nmcp://b" }] });
  assert.ok(errs.some((e) => /tools\[0\]\.ref/.test(e)), `expected reject; got ${JSON.stringify(errs)}`);
});

function omit<T extends object>(o: T, key: keyof T): Omit<T, keyof T> {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

// --- T3: the schema checker and validateAgentfile AGREE on accept/reject ---
// This is the drift guard: the published schema can never silently diverge from
// the runtime validator, because one shared corpus runs through BOTH and the
// accept/reject verdict must be identical on every case.

const ACCEPTS: unknown[] = [
  VALID,
  { $schema: "./agentfile.schema.json", ...VALID },
  { ...VALID, requires: { ...VALID.requires, tool_locality: "in-process" } },
  { ...VALID, requires: { ...VALID.requires, tool_locality: "remote" } },
  { ...VALID, tools: [{ ref: "grpc://svc/method" }] },
  { ...VALID, tools: [{ ref: "mcp://a\nmore" }] }, // scheme on the first segment → both accept
  { ...VALID, harness: {}, requires: {}, sandbox: { backend: "inmemory", network: "deny-all" } },
];

const INVALIDS: unknown[] = [
  ...REJECTS.map((r) => r.bad),
  { ...VALID, tools: [{ ref: "x://a\nmcp://b" }] }, // non-scheme first segment → both reject
];

function runtimeAccepts(v: unknown): boolean {
  try {
    validateAgentfile(v);
    return true;
  } catch {
    return false;
  }
}

function label(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

test("T3 agreement: schema checker and validateAgentfile agree on the whole corpus", () => {
  for (const c of ACCEPTS) {
    const schemaOk = checkAgainstSchema(c).length === 0;
    const runtimeOk = runtimeAccepts(c);
    assert.ok(schemaOk, `schema should ACCEPT ${label(c)}; errs=${JSON.stringify(checkAgainstSchema(c))}`);
    assert.ok(runtimeOk, `validateAgentfile should ACCEPT ${label(c)}`);
    assert.equal(schemaOk, runtimeOk, `agreement on ${label(c)}`);
  }
  for (const c of INVALIDS) {
    const schemaOk = checkAgainstSchema(c).length === 0;
    const runtimeOk = runtimeAccepts(c);
    assert.ok(!schemaOk, `schema should REJECT ${label(c)}`);
    assert.ok(!runtimeOk, `validateAgentfile should REJECT ${label(c)}`);
    assert.equal(schemaOk, runtimeOk, `agreement on ${label(c)}`);
  }
});

test("T3: a TOP-LEVEL $schema key is digest-neutral (dropped from the parsed model)", () => {
  const withSchema = validateAgentfile({ $schema: "./agentfile.schema.json", ...VALID });
  const without = validateAgentfile(VALID);
  assert.deepEqual(withSchema, without, "top-level $schema must not change the parsed model");
  assert.ok(!("$schema" in withSchema), "$schema is not retained in the model (hence not in the digest)");
});
