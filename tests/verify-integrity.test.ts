import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImage,
  verifyImage,
  computeImageDigest,
  makeLocalResolver,
  parseAgentfileJson,
} from "@iris/agent";
import type { ToolContract } from "@iris/tools";

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
const readFile = (): Promise<Uint8Array> => Promise.resolve(new TextEncoder().encode("be helpful"));

test("T6: verify passes for an intact image", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  await verifyImage(img, { resolver }); // must not throw
});

test("T6: verify fails loudly on a dangling tool ref", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  await assert.rejects(
    () => verifyImage(img, { resolver: makeLocalResolver({}) }),
    /dangling|resolvable/i,
  );
});

test("T6: verify fails loudly on a tampered content hash", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  const tampered = {
    ...img,
    content: { ...img.content, "instructions.md": Buffer.from("evil").toString("base64") },
  };
  // content bytes differ from the recorded lock hash (content check fires first)
  await assert.rejects(() => verifyImage(tampered, { resolver }), /content hash mismatch/i);
});

test("T6: verify fails loudly on a wrong stored imageDigest", async () => {
  const img = await buildImage(MODEL, { resolver, readFile });
  const bad = { ...img, lock: { ...img.lock, imageDigest: "0".repeat(64) } };
  await assert.rejects(() => verifyImage(bad, { resolver }), /imageDigest mismatch/i);
});

test("T6: verify resolves by the stable ref, NOT the floating location (pin-contract/float-impl)", async () => {
  // the resolved contract's location differs from its Agentfile ref/base — the
  // exact ADR-0004 "float the implementation" case. verify must still pass.
  const floatResolver = makeLocalResolver({
    "mcp://registry/issue-tracker": {
      name: "issue-tracker", description: "track", inputSchema: {},
      transport: "mcp", location: "mcp://prod-cluster-7/issue-tracker-v3", retrySafe: false,
    } as ToolContract,
  });
  const img = await buildImage(MODEL, { resolver: floatResolver, readFile });
  assert.equal(img.lock.tools[0].ref, "mcp://registry/issue-tracker@^2");
  assert.equal(img.lock.tools[0].location, "mcp://prod-cluster-7/issue-tracker-v3");
  // resolving by the ranged ref (via the base fallback) must succeed — no spurious dangling
  await verifyImage(img, { resolver: floatResolver });
});

test("T6: a consistently re-signed image with a stale content hash still fails", async () => {
  // tamper content AND re-sign the imageDigest → only the content-hash check catches it
  const img = await buildImage(MODEL, { resolver, readFile });
  const tampered = {
    ...img,
    content: { ...img.content, "instructions.md": Buffer.from("evil").toString("base64") },
    lock: { ...img.lock },
  };
  tampered.lock.imageDigest = computeImageDigest(tampered);
  await assert.rejects(() => verifyImage(tampered, { resolver }), /content hash mismatch/i);
});
