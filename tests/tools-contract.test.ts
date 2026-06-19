import { test } from "node:test";
import assert from "node:assert/strict";
import { contractDigest, makeToolRegistry } from "@iris/tools";
import type { ToolContract } from "@iris/tools";

const base: ToolContract = {
  name: "weather",
  description: "Get the weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
  transport: "subprocess",
  location: "subprocess://weather",
  retrySafe: false,
};

// T1 — contractDigest is deterministic over the MODEL surface.
test("T1: contractDigest is deterministic over the model surface (key order irrelevant)", () => {
  const a = contractDigest(base);
  // same model surface, inputSchema keys reordered → canonicalize sorts → same digest
  const b = contractDigest({
    ...base,
    inputSchema: { properties: { city: { type: "string" } }, type: "object" },
  });
  assert.equal(a, b);
  // a sha256 hex digest is 64 lowercase hex chars
  assert.match(a, /^[0-9a-f]{64}$/);
});

// T1 — transport/location/retrySafe do NOT change the digest (they float, ADR-0004).
test("T1: transport/location/retrySafe changes do NOT change the digest", () => {
  const d = contractDigest(base);
  assert.equal(contractDigest({ ...base, transport: "mcp" }), d);
  assert.equal(contractDigest({ ...base, location: "mcp://somewhere-else" }), d);
  assert.equal(contractDigest({ ...base, retrySafe: true }), d);
});

// T1 — name/description/inputSchema DO change the digest (model-perceived surface).
test("T1: name/description/inputSchema changes DO change the digest", () => {
  const d = contractDigest(base);
  assert.notEqual(contractDigest({ ...base, name: "forecast" }), d);
  assert.notEqual(contractDigest({ ...base, description: "Something else" }), d);
  assert.notEqual(contractDigest({ ...base, inputSchema: { type: "string" } }), d);
});

// T1 — a name collision is rejected loudly (build-time check).
test("T1: registry rejects a duplicate tool name loudly", () => {
  const reg = makeToolRegistry([base]);
  assert.throws(
    () => reg.register({ ...base, transport: "mcp", location: "mcp://weather" }),
    /duplicate tool name/,
  );
});

// T1 — registry resolves a registered contract by name; absent → undefined.
test("T1: registry resolves a registered contract by name", () => {
  const reg = makeToolRegistry([base]);
  assert.equal(reg.get("weather")?.name, "weather");
  assert.ok(reg.has("weather"));
  assert.equal(reg.get("nope"), undefined);
  assert.equal(reg.has("nope"), false);
  assert.deepEqual(reg.names(), ["weather"]);
});
