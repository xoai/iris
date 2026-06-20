import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImage,
  inspectImage,
  writeOciLayout,
  readOciLayout,
  makeLocalResolver,
  parseAgentfileJson,
} from "@irisrun/agent";
import type { ToolContract } from "@irisrun/tools";

const resolver = makeLocalResolver({
  "mcp://registry/issue-tracker": {
    name: "issue-tracker", description: "track", inputSchema: {},
    transport: "mcp", location: "mcp://registry/issue-tracker", retrySafe: false,
  } as ToolContract,
});
const MODEL = parseAgentfileJson(JSON.stringify({
  apiVersion: "iris/v1", kind: "Agent", name: "support-triage", model: "anthropic/claude-x",
  instructions: "./instructions.md", skills: [],
  tools: [{ ref: "mcp://registry/issue-tracker@^2" }], connections: [],
  harness: { bundle: "default" },
  requires: { tool_locality: "remote" },
  sandbox: { backend: "inmemory", network: "deny-all" },
}));
const readFile = (p: string): Promise<Uint8Array> =>
  Promise.resolve(new TextEncoder().encode(p === "./instructions.md" ? "be helpful" : ""));

test("T5: inspectImage returns the resolved intent", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  const info = inspectImage(img);
  assert.equal(info.name, "support-triage");
  assert.equal(info.model, "anthropic/claude-x");
  assert.equal(info.imageDigest, img.lock.imageDigest);
  assert.equal(info.tools.length, 1);
  assert.ok("instructions.md" in info.content);
});

test("T5: inspectImage surfaces declared secrets + environment (omitted when absent)", async () => {
  const base = inspectImage(await buildImage(MODEL, { resolver, readFile }));
  assert.ok(!("secrets" in base), "absent secrets omitted from inspection");
  assert.ok(!("environment" in base), "absent environment omitted from inspection");

  const withEnv = parseAgentfileJson(JSON.stringify({
    apiVersion: "iris/v1", kind: "Agent", name: "support-triage", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [],
    tools: [{ ref: "mcp://registry/issue-tracker@^2" }], connections: [],
    harness: { bundle: "default" }, requires: { tool_locality: "remote" },
    sandbox: { backend: "inmemory", network: "deny-all" },
    secrets: ["GITHUB_TOKEN"], environment: { LOG_LEVEL: "info" },
  }));
  const info = inspectImage(await buildImage(withEnv, { resolver, readFile }));
  assert.deepEqual(info.secrets, ["GITHUB_TOKEN"]);
  assert.deepEqual(info.environment, { LOG_LEVEL: "info" });
});

test("T5: OCI layout write→read round-trips the image (structural files present)", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  const dir = await mkdtemp(join(tmpdir(), "iris-oci-"));
  await writeOciLayout(dir, img);

  // structural OCI layout files
  const layout = JSON.parse(await fsReadFile(join(dir, "oci-layout"), "utf8"));
  assert.equal(layout.imageLayoutVersion, "1.0.0");
  const index = JSON.parse(await fsReadFile(join(dir, "index.json"), "utf8"));
  assert.ok(Array.isArray(index.manifests) && index.manifests.length === 1);
  assert.match(index.manifests[0].digest, /^sha256:[0-9a-f]{64}$/);
  // the blob exists under blobs/sha256/<hex>
  const blobDigest = index.manifests[0].digest.replace(/^sha256:/, "");
  await fsReadFile(join(dir, "blobs", "sha256", blobDigest), "utf8");

  // round-trip
  const back = await readOciLayout(dir);
  assert.deepEqual(back, img);
  assert.equal(back.lock.imageDigest, img.lock.imageDigest);
});
