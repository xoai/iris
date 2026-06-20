import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImage, makeLocalResolver, parseAgentfileJson } from "@irisrun/agent";
import type { ToolContract } from "@irisrun/tools";

const issueTracker: ToolContract = {
  name: "issue-tracker", description: "track", inputSchema: { type: "object" },
  transport: "mcp", location: "mcp://registry/issue-tracker", retrySafe: false,
};
const csvStats: ToolContract = {
  name: "csv-stats", description: "csv", inputSchema: {},
  transport: "subprocess", location: "subprocess://./tools/csv-stats", retrySafe: true,
};
const github: ToolContract = {
  name: "github", description: "gh", inputSchema: {},
  transport: "mcp", location: "mcp://connect/github", retrySafe: false,
};
const resolver = makeLocalResolver({
  "mcp://registry/issue-tracker": issueTracker,
  "subprocess://./tools/csv-stats": csvStats,
  "mcp://connect/github": github,
});

const MODEL = parseAgentfileJson(JSON.stringify({
  apiVersion: "iris/v1", kind: "Agent", name: "support-triage", model: "anthropic/claude-x",
  instructions: "./instructions.md",
  skills: ["./skills/refunds.md", "./skills/escalation.md"],
  tools: [{ ref: "mcp://registry/issue-tracker@^2" }, { ref: "subprocess://./tools/csv-stats" }],
  connections: [{ ref: "mcp://connect/github" }],
  harness: { bundle: "default" },
  requires: { long_running: true, local_subprocess: true, tool_locality: "local" },
  sandbox: { backend: "docker", workspace: "./workspace", network: "deny-all" },
}));

const FILES: Record<string, string> = {
  "./instructions.md": "You are a triage agent.",
  "./skills/refunds.md": "Refund policy.",
  "./skills/escalation.md": "Escalate when stuck.",
  "./workspace": "seed",
};
const readFile = (p: string): Promise<Uint8Array> => {
  const v = FILES[p];
  if (v === undefined) return Promise.reject(new Error(`no file: ${p}`));
  return Promise.resolve(new TextEncoder().encode(v));
};

test("T4: builds an image; content embedded by hash; two identical builds → identical imageDigest", async () => {
  const a = await buildImage(MODEL, { resolver, readFile });
  const b = await buildImage(MODEL, { resolver, readFile });
  assert.match(a.lock.imageDigest, /^[0-9a-f]{64}$/);
  assert.equal(a.lock.imageDigest, b.lock.imageDigest, "deterministic digest");
  // content embedded + hashed, keyed by a normalized (no leading ./) path
  assert.match(a.lock.content["instructions.md"], /^[0-9a-f]{64}$/);
  assert.ok("skills/refunds.md" in a.lock.content);
  // tools pinned by contractDigest
  assert.equal(a.lock.tools.length, 3);
  assert.match(a.lock.tools[0].contractDigest, /^[0-9a-f]{64}$/);
});

test("T4: changing embedded content changes the imageDigest", async () => {
  const a = await buildImage(MODEL, { resolver, readFile });
  const readFile2 = (p: string): Promise<Uint8Array> =>
    Promise.resolve(new TextEncoder().encode(p === "./instructions.md" ? "DIFFERENT" : FILES[p]));
  const b = await buildImage(MODEL, { resolver, readFile: readFile2 });
  assert.notEqual(a.lock.imageDigest, b.lock.imageDigest);
});

test("T4: content values are base64 strings (canonicalize-safe; never Buffer/Uint8Array)", async () => {
  const a = await buildImage(MODEL, { resolver, readFile });
  for (const v of Object.values(a.content)) assert.equal(typeof v, "string");
});
