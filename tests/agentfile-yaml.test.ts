import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentfileYaml, parseAgentfileJson, parseYamlValue } from "@iris/agent";

const YAML = `# an authored Agentfile
apiVersion: iris/v1
kind: Agent
name: support-triage
model: anthropic/claude-x          # resolved + pinned at build
instructions: ./instructions.md
skills:
  - ./skills/refunds.md
  - ./skills/escalation.md
tools:
  - ref: mcp://registry/issue-tracker@^2
  - ref: subprocess://./tools/csv-stats
connections:
  - ref: mcp://connect/github
harness:
  bundle: default
requires:
  long_running: true
  local_subprocess: true
  tool_locality: local
sandbox:
  backend: docker
  workspace: ./workspace
  network: deny-all
`;

const JSON_EQUIV = {
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

test("T2: YAML authoring surface parses to the SAME model as the equivalent JSON", () => {
  const fromYaml = parseAgentfileYaml(YAML);
  const fromJson = parseAgentfileJson(JSON.stringify(JSON_EQUIV));
  assert.deepEqual(fromYaml, fromJson);
});

test("T2: booleans parse as booleans (not strings)", () => {
  const m = parseAgentfileYaml(YAML);
  assert.equal(m.requires.long_running, true);
  assert.equal(m.requires.tool_locality, "local");
});

test("T2: a quoted value containing ' #' is NOT truncated (quote-aware comment stripping)", () => {
  const v = parseYamlValue("name: 'a #b'\nother: x  # a real comment") as {
    name: string;
    other: string;
  };
  assert.equal(v.name, "a #b");
  assert.equal(v.other, "x");
});

test("T2: duplicate map keys are rejected loudly", () => {
  assert.throws(() => parseYamlValue("name: a\nname: b"), /duplicate key/i);
});

test("T2: unsupported YAML constructs are rejected loudly", () => {
  assert.throws(() => parseAgentfileYaml("name: [a, b]"), /flow|unsupported/i);
  assert.throws(() => parseAgentfileYaml("name: { a: 1 }"), /flow|unsupported/i);
  assert.throws(() => parseAgentfileYaml("a: &anchor x"), /anchor|unsupported/i);
  assert.throws(() => parseAgentfileYaml("---\nname: x"), /document|multi|unsupported/i);
  assert.throws(() => parseAgentfileYaml("name:\n\tkey: v"), /tab|unsupported/i);
});
