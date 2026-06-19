import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLocalResolver, resolveLockTools, validateCapabilities } from "@iris/agent";
import type { ToolContract } from "@iris/tools";

const issueTracker: ToolContract = {
  name: "issue-tracker",
  description: "track issues",
  inputSchema: { type: "object" },
  transport: "mcp",
  location: "mcp://registry/issue-tracker",
  retrySafe: false,
};
const csvStats: ToolContract = {
  name: "csv-stats",
  description: "csv stats",
  inputSchema: {},
  transport: "subprocess",
  location: "subprocess://./tools/csv-stats",
  retrySafe: true,
};

const resolver = makeLocalResolver({
  "mcp://registry/issue-tracker": issueTracker,
  "subprocess://./tools/csv-stats": csvStats,
});

test("T3: resolves ^range refs to concrete contractDigests pinned in lock tools", async () => {
  const tools = await resolveLockTools(
    [{ ref: "mcp://registry/issue-tracker@^2" }, { ref: "subprocess://./tools/csv-stats" }],
    resolver,
  );
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "issue-tracker");
  assert.match(tools[0].contractDigest, /^[0-9a-f]{64}$/);
  assert.equal(tools[0].transport, "mcp");
  assert.equal(tools[1].transport, "subprocess");
  assert.equal(tools[1].retrySafe, true);
});

test("T3: a dangling ref → loud error", async () => {
  await assert.rejects(
    () => resolveLockTools([{ ref: "mcp://registry/nope@^1" }], resolver),
    /dangling|unresolv|resolve/i,
  );
});

test("T3: an in-process resolution for an Agentfile ref → loud reject (not authorable)", async () => {
  const r = makeLocalResolver({
    "mcp://x": { ...issueTracker, transport: "in-process", location: "inproc://x" },
  });
  await assert.rejects(() => resolveLockTools([{ ref: "mcp://x" }], r), /in-process|authorable/i);
});

test("T3: capability validation — tool_locality:remote forbids subprocess tools", async () => {
  const tools = await resolveLockTools([{ ref: "subprocess://./tools/csv-stats" }], resolver);
  assert.throws(
    () => validateCapabilities({ tool_locality: "remote", local_subprocess: true }, tools),
    /remote|subprocess/i,
  );
});

test("T3: capability validation — a subprocess tool requires local_subprocess", async () => {
  const tools = await resolveLockTools([{ ref: "subprocess://./tools/csv-stats" }], resolver);
  assert.throws(() => validateCapabilities({ tool_locality: "local" }, tools), /local_subprocess/i);
  // declaring the capability passes:
  validateCapabilities({ tool_locality: "local", local_subprocess: true }, tools);
});
