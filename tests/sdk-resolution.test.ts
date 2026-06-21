// @irisrun/sdk is a CURATED re-export surface: every adapter-authoring name must
// resolve from the one import, and it must NOT depend on the CLI (the dependency
// direction is cli → sdk, never the reverse).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PACKAGE,
  runStoreConformance,
  runSchedulerConformance,
  runChannelPortConformance,
  runModelProviderConformance,
  register,
  makeChannelSession,
  toOutcomeEvent,
} from "@irisrun/sdk";

test("sdk: re-exports all three conformance runners + register + channel helpers", () => {
  assert.equal(PACKAGE, "@irisrun/sdk");
  const fns = [
    runStoreConformance,
    runSchedulerConformance,
    runChannelPortConformance,
    runModelProviderConformance,
    register,
    makeChannelSession,
    toOutcomeEvent,
  ];
  for (const fn of fns) assert.equal(typeof fn, "function", "every re-exported runtime name is callable");
});

test("sdk: the one `register` wires cases from any suite (structural ConformanceCase)", () => {
  const names: string[] = [];
  const fakeTest = (name: string): void => {
    names.push(name);
  };
  // provider cases through the sdk's single canonical `register`
  register(runModelProviderConformance({
    name: "probe",
    envKey: "PROBE_API_KEY",
    makeBuffered: () => (async () => ({ ok: true, value: {} })) as never,
    makeStreaming: () => (async () => ({ ok: true, value: {} })) as never,
    bufferedResponseBody: () => ({}),
    streamingSseBody: () => "",
    fallbackResponseBody: () => ({}),
    malformedSseBody: () => "",
    expected: { content: "", stopReason: "", usage: { inputTokens: 0, outputTokens: 0 } },
    expectedFallback: { content: "", usage: { inputTokens: 0, outputTokens: 0 } },
    assertRequestShape: () => {},
    modelFromBody: (b) => b.model,
  }), fakeTest);
  assert.ok(names.length > 0, "register fed provider cases into the runner");
});

test("sdk: declares NO dependency on the CLI", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "packages", "sdk", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.ok(!deps.includes("iris-runtime"), "sdk must not depend on the CLI (iris-runtime)");
  assert.ok(!deps.some((d) => d === "iris" || d.endsWith("/cli")), "sdk must not depend on any cli package");
});
