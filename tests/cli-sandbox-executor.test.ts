// C3 (sandbox-runtime-wiring): buildSandboxExecutor turns the Agentfile `sandbox:`
// block into a SandboxExecutor for `--sandbox`. The refusals + resolution are pure
// logic, verifiable in CI without Docker (the real in-container exec is the gated
// smoke). The non-node / multi-file refusals fire BEFORE any docker call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxExecutor, parseNetworkPolicy } from "iris-runtime";

test("refuses the inmemory backend for real tools", () => {
  assert.throws(
    () => buildSandboxExecutor({ backend: "inmemory", network: "deny-all" }),
    /inmemory.*test backend/,
  );
});

test("rejects an unknown backend", () => {
  assert.throws(
    () => buildSandboxExecutor({ backend: "wasm", network: "deny-all" }),
    /unknown backend/,
  );
});

test("docker backend builds an executor; exec refuses non-node and multi-file specs", async () => {
  const exec = buildSandboxExecutor({ backend: "docker", network: "deny-all" });
  await assert.rejects(
    () => exec.exec({ command: "python", args: ["x.py"] }, new Uint8Array(), 1000),
    /only node exec tools/,
  );
  await assert.rejects(
    () => exec.exec({ command: process.execPath, args: ["a.mjs", "b.mjs"] }, new Uint8Array(), 1000),
    /single-file/,
  );
});

test("parseNetworkPolicy maps the floors and rejects an allowlist string", () => {
  assert.equal(parseNetworkPolicy("deny-all"), "deny-all");
  assert.equal(parseNetworkPolicy("allow-all"), "allow-all");
  assert.throws(() => parseNetworkPolicy("allow:a.com"), /not supported yet/);
});
