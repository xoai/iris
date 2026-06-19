// M6 T7 — bundle pinning by a REAL content digest + an EXTENDED verifyImage.
// Today buildImage pins `Lock.tactics.bundle = {id, digest: sha256Hex(id)}` — a
// placeholder over the id string only — and verifyImage never touches the bundle.
// M6 introduces a resolved BundleDefinition + bundleDigest(def) = sha256 over the
// canonical BEHAVIOR surface (stable across a floating `location`, ADR-0004), pins
// the real digest WHEN a resolveBundle resolver is injected, and EXTENDS verifyImage
// to re-resolve the bundle by its STABLE id/ref and recompute+compare the digest.
//
// Back-compat is load-bearing: WITHOUT a resolveBundle resolver, build keeps the
// sha256Hex(id) placeholder byte-unchanged and verify behaves exactly as M4. The
// content-tamper case exercises the NEW re-resolve loop SPECIFICALLY (the lock
// digest is left unchanged, so the pre-existing imageDigest check passes).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImage,
  verifyImage,
  sha256Hex,
  bundleDigest,
  makeLocalResolver,
  parseAgentfileJson,
} from "@iris/agent";
import type { BundleDefinition, BundleResolver, AgentImage } from "@iris/agent";
import type { ToolContract } from "@iris/tools";

const toolResolver = makeLocalResolver({
  "mcp://registry/issue-tracker": {
    name: "issue-tracker", description: "track", inputSchema: {},
    transport: "mcp", location: "mcp://registry/issue-tracker", retrySafe: false,
  } as ToolContract,
});

function model(bundle: string) {
  return parseAgentfileJson(JSON.stringify({
    apiVersion: "iris/v1", kind: "Agent", name: "coding-agent", model: "anthropic/claude-x",
    instructions: "./instructions.md", skills: [],
    tools: [{ ref: "mcp://registry/issue-tracker@^2" }], connections: [],
    harness: { bundle },
    requires: { tool_locality: "remote" },
    sandbox: { backend: "inmemory", network: "deny-all" },
  }));
}
const readFile = (): Promise<Uint8Array> => Promise.resolve(new TextEncoder().encode("be helpful"));

// The resolved coding bundle definition. `location` FLOATS (deploy detail);
// id/version/seams are the stable behavior surface the digest covers.
const CODING_DEF: BundleDefinition = {
  id: "iris/coding",
  version: "1.0.0",
  seams: ["assembleContext", "shouldCompact", "decideNext", "gateAction", "onToolError"],
  location: "registry://prod-cluster-7/iris-coding@sha-abc",
};

function bundleResolver(def: BundleDefinition): BundleResolver {
  return { resolve: () => Promise.resolve(def) };
}

test("T7: bundleDigest is sha256(canonical behavior surface) and is STABLE across a floating location", () => {
  const d1 = bundleDigest(CODING_DEF);
  const d2 = bundleDigest({ ...CODING_DEF, location: "registry://other/place@sha-zzz" });
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.equal(d1, d2, "a floating location must NOT change the digest (ADR-0004)");
  // a real content change (the behavior surface) DOES change the digest
  const d3 = bundleDigest({ ...CODING_DEF, seams: [...CODING_DEF.seams, "spawnPolicy"] });
  assert.notEqual(d1, d3, "a behavior-surface change DOES change the digest");
});

test("T7: WITH resolveBundle, buildImage pins the REAL bundleDigest (not sha256Hex(id))", async () => {
  const img = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  assert.ok(img.lock.tactics.bundle, "the bundle is pinned");
  assert.equal(img.lock.tactics.bundle.id, "iris/coding@^1", "the id is the Agentfile ref");
  assert.equal(
    img.lock.tactics.bundle.digest,
    bundleDigest(CODING_DEF),
    "the pinned digest is the REAL content digest",
  );
  assert.notEqual(
    img.lock.tactics.bundle.digest,
    sha256Hex("iris/coding@^1"),
    "the pinned digest is NOT the sha256Hex(id) placeholder",
  );
});

test("T7 (back-compat): WITHOUT resolveBundle, buildImage keeps the sha256Hex(id) placeholder byte-unchanged", async () => {
  const img = await buildImage(model("default"), { resolver: toolResolver, readFile });
  assert.ok(img.lock.tactics.bundle);
  assert.equal(
    img.lock.tactics.bundle.digest,
    sha256Hex("default"),
    "the M4 placeholder is preserved exactly",
  );
});

test("T7: an EXACT M4-style build (no resolveBundle) is byte-identical to the pre-M6 build", async () => {
  // The whole image digest must be unchanged when no resolveBundle is injected —
  // this is what keeps every existing M4 build/verify test green.
  const img = await buildImage(model("default"), { resolver: toolResolver, readFile });
  // imageDigest is computed over the placeholder-pinned lock; recompute matches
  await verifyImage(img, { resolver: toolResolver }); // M4 verify path unchanged
  assert.equal(img.lock.tactics.bundle?.digest, sha256Hex("default"));
});

test("T7: verifyImage WITH resolveBundle passes for an intact image (re-resolve digest matches)", async () => {
  const img = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  await verifyImage(img, { resolver: toolResolver, resolveBundle: bundleResolver(CODING_DEF) });
});

test("T7: verifyImage WITH resolveBundle re-resolves by the STABLE ref even when location FLOATS", async () => {
  const img = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  // the verify-time resolver returns the SAME behavior surface but a DIFFERENT
  // floating location — verify must still pass (re-resolved by stable ref/id).
  const floated: BundleDefinition = { ...CODING_DEF, location: "registry://NEW-cluster/iris-coding@sha-xyz" };
  await verifyImage(img, { resolver: toolResolver, resolveBundle: bundleResolver(floated) });
});

test("T7: a CONTENT-tampered bundle (lock digest unchanged) FAILS the NEW re-resolve loop loudly", async () => {
  const img = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  // The pinned Lock.tactics.bundle.digest is LEFT UNCHANGED (so the pre-existing
  // imageDigest check passes) — only the RESOLVED content is mutated. Caught ONLY
  // by the new re-resolve-and-recompute loop.
  const tamperedDef: BundleDefinition = { ...CODING_DEF, seams: ["gateAction"] }; // behavior surface mutated
  await assert.rejects(
    () => verifyImage(img, { resolver: toolResolver, resolveBundle: bundleResolver(tamperedDef) }),
    /bundle.*digest|bundle.*mismatch|tactic/i,
  );
});

test("T7: a dangling bundle ref (resolveBundle returns null) FAILS loudly", async () => {
  const img = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  const nullResolver: BundleResolver = { resolve: () => Promise.resolve(null) };
  await assert.rejects(
    () => verifyImage(img, { resolver: toolResolver, resolveBundle: nullResolver }),
    /dangling|resolvable|bundle/i,
  );
});

test("T7 (back-compat): verifyImage WITHOUT resolveBundle never touches the bundle (M4 behavior)", async () => {
  // Build WITH a real bundle pin, then verify WITHOUT a resolveBundle — must pass
  // exactly as M4 (the bundle loop is skipped when no resolver is injected).
  const img: AgentImage = await buildImage(model("iris/coding@^1"), {
    resolver: toolResolver,
    readFile,
    resolveBundle: bundleResolver(CODING_DEF),
  });
  await verifyImage(img, { resolver: toolResolver }); // no resolveBundle → M4 path, no throw
});
