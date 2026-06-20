// M6 T5 — the capability-diff DEPLOY gate (spec §3, done-when #2). `assertDeployable`
// is the deploy-time check of an image's CapabilityProfile against a host adapter:
// it refuses LOUDLY (never silently degrades) when the host cannot satisfy a required
// capability. The load-bearing case is the LITERAL refusal for local tools on
// a remote-only edge host — with edgeHost(...).name === "Cloudflare" the rendered message
// must be BYTE-IDENTICAL to the example. diffCapabilities exposes the structured
// gaps for inspection. The remote-only profile passes with zero gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeployable, diffCapabilities } from "@irisrun/host";
import { edgeHost } from "@irisrun/store-do";
import type { CapabilityProfile } from "@irisrun/agent";
import { FakeDoStorage } from "./lib/fake-do.ts";

// The byte-identical host-capability refusal (host.name="Cloudflare").
const LOCAL_TOOLS_REFUSAL =
  "this agent requires local_subprocess tools; the Cloudflare target supports remote MCP tools only. Set tool_locality: remote or choose a VPS/serverless target.";

function edge() {
  return edgeHost(new FakeDoStorage()); // default name "Cloudflare"
}

test("T5: an over-capable image (local_subprocess:true) on the Cloudflare edge throws the BYTE-IDENTICAL refusal", () => {
  const requires: CapabilityProfile = { local_subprocess: true };
  let thrown: Error | undefined;
  try {
    assertDeployable(requires, edge());
  } catch (e) {
    thrown = e as Error;
  }
  assert.ok(thrown instanceof Error, "assertDeployable must throw for an over-capable image");
  // Byte-identical to the rendered refusal template — exact-string equality.
  assert.equal(thrown.message, LOCAL_TOOLS_REFUSAL);
});

test("T5: an over-capable image (tool_locality:'local') on the Cloudflare edge throws the BYTE-IDENTICAL refusal", () => {
  const requires: CapabilityProfile = { tool_locality: "local" };
  assert.throws(
    () => assertDeployable(requires, edge()),
    (e: Error) => e.message === LOCAL_TOOLS_REFUSAL,
  );
});

test("T5: the literal-message assertion is NON-VACUOUS — a non-Cloudflare host name changes the rendered string", () => {
  // Same over-capable image, a DIFFERENT host name → the interpolated message must
  // differ from the Cloudflare literal (proves the assertion above is not vacuous and
  // genuinely depends on host.name === "Cloudflare"). The host name is read at runtime
  // (a `string` field), so the rendered message is not a compile-time constant here.
  const storage = new FakeDoStorage();
  const flyName: string = "Fly";
  const fly = edgeHost(storage, flyName);
  const flyGap = diffCapabilities({ local_subprocess: true }, fly)[0]!;
  assert.equal(
    flyGap.message,
    "this agent requires local_subprocess tools; the Fly target supports remote MCP tools only. Set tool_locality: remote or choose a VPS/serverless target.",
  );
  // Genuinely differs from the Cloudflare literal — the message depends on host.name.
  assert.notEqual(flyGap.message, LOCAL_TOOLS_REFUSAL);
});

test("T5: a remote-only image (tool_locality:'remote') deploys to the edge with ZERO gaps and no throw", () => {
  const requires: CapabilityProfile = { tool_locality: "remote" };
  assert.deepEqual(diffCapabilities(requires, edge()), []);
  assert.doesNotThrow(() => assertDeployable(requires, edge()));
});

test("T5: an empty / undefined-tool_locality image deploys to the edge with zero gaps (remote is the default demand)", () => {
  assert.deepEqual(diffCapabilities({}, edge()), []);
  assert.doesNotThrow(() => assertDeployable({}, edge()));
});

test("T5: a websockets-requiring image gets the PRECISE per-cap message (not the refusal template)", () => {
  const requires: CapabilityProfile = { websockets: true };
  const gaps = diffCapabilities(requires, edge());
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.capability, "websockets");
  assert.equal(gaps[0]!.required, true);
  assert.equal(gaps[0]!.hostProvides, false);
  // The checkHostCapabilities-style precise per-cap message.
  assert.equal(gaps[0]!.message, "websockets (required true, host has false)");
  assert.throws(
    () => assertDeployable(requires, edge()),
    (e: Error) => e.message === "websockets (required true, host has false)",
  );
});

test("T5: diffCapabilities returns STRUCTURED gaps for inspection (capability/required/hostProvides/message)", () => {
  // An image demanding BOTH a boolean cap (filesystem) and an over-ceiling locality.
  const requires: CapabilityProfile = { filesystem: true, tool_locality: "in-process" };
  const gaps = diffCapabilities(requires, edge());
  // One filesystem boolean gap + one local-tools-on-edge gap.
  const byCap = new Map(gaps.map((g) => [g.capability, g]));
  assert.ok(byCap.has("filesystem"), "filesystem gap present");
  assert.equal(byCap.get("filesystem")!.message, "filesystem (required true, host has false)");
  assert.ok(byCap.has("tool_locality"), "tool_locality gap present");
  assert.equal(byCap.get("tool_locality")!.required, "in-process");
  assert.equal(byCap.get("tool_locality")!.hostProvides, "remote");
  assert.equal(byCap.get("tool_locality")!.message, LOCAL_TOOLS_REFUSAL);
  // assertDeployable joins EVERY gap's message.
  assert.throws(
    () => assertDeployable(requires, edge()),
    (e: Error) =>
      e.message.includes("filesystem (required true, host has false)") &&
      e.message.includes(LOCAL_TOOLS_REFUSAL),
  );
});

test("T5: an image demanding BOTH local_subprocess AND an over-ceiling tool_locality renders the refusal exactly ONCE (deduped)", () => {
  // The realistic combo (an Agentfile wanting local-subprocess tools naturally also
  // sets tool_locality: local) — ONE root cause, so the user-facing message must NOT
  // double the refusal sentence. diffCapabilities still surfaces BOTH structured gaps.
  const requires: CapabilityProfile = { local_subprocess: true, tool_locality: "local" };
  const gaps = diffCapabilities(requires, edge());
  // Two structured gaps (one per capability) — both carry the same literal refusal.
  assert.equal(gaps.length, 2);
  assert.deepEqual(
    gaps.map((g) => g.capability).sort(),
    ["local_subprocess", "tool_locality"],
  );
  assert.ok(gaps.every((g) => g.message === LOCAL_TOOLS_REFUSAL));
  // But the THROWN message renders the refusal sentence exactly once (deduped),
  // byte-identical to the single literal — not "<refusal>; <refusal>".
  let thrown: Error | undefined;
  try {
    assertDeployable(requires, edge());
  } catch (e) {
    thrown = e as Error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, LOCAL_TOOLS_REFUSAL);
});
