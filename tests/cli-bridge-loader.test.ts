// The pluggable bridge loader (packages/cli/src/bridge.ts): `iris bridge <module>`
// dynamic-imports a module exporting `openBridge(opts)` and serves it in front of a running
// channel; bad modules fail loudly. Proves a platform bridge plugs into the CLI by module
// specifier — the channel analog of the `--store`/`--channel` loaders. (The bridge's
// behavior is covered by runAdapterConformance in tests/platform-bridges.test.ts; this
// exercises LOADING.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { PlatformAdapter } from "@irisrun/bridge";
import { resolveBridge } from "../packages/cli/src/bridge.ts";

test("resolveBridge: a module exporting openBridge is loaded and builds a PlatformAdapter", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = pathToFileURL(join(here, "lib", "fake-bridge-module.ts")).href;
  const open = await resolveBridge(spec);
  const adapter = (await open({ env: { FAKE_CONV: "room-7" } })) as PlatformAdapter<unknown>;
  assert.equal(typeof adapter.verify, "function");
  assert.equal(typeof adapter.parse, "function");
  assert.equal(typeof adapter.formatReply, "function");
  const parsed = adapter.parse("hello");
  assert.deepEqual(parsed, { kind: "message", conversationId: "room-7", text: "hello" });
});

test("resolveBridge: an existing reference bridge example (discord) loads via openBridge", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = pathToFileURL(join(here, "..", "examples", "bridges", "discord.ts")).href;
  const open = await resolveBridge(spec);
  const adapter = (await open({ env: { DISCORD_PUBLIC_KEY: "00".repeat(32) } })) as PlatformAdapter<unknown>;
  assert.equal(adapter.name, "discord");
  assert.equal(typeof adapter.verify, "function");
});

test("resolveBridge: a module without openBridge fails loudly", async () => {
  await assert.rejects(resolveBridge("@irisrun/core"), /must export openBridge/);
});

test("resolveBridge: an unresolvable module fails loudly", async () => {
  await assert.rejects(resolveBridge("@irisrun/bridge-does-not-exist-xyz"), /could not import/);
});

// Wiring guard (source assertion): cmdBridge selects its bridge via resolveBridge, so
// `iris bridge` goes through the loader.
test("cmdBridge wires the bridge through resolveBridge", () => {
  const iris = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "iris.ts"),
    "utf8",
  );
  assert.match(iris, /resolveBridge\(moduleSpec\)/, "cmdBridge must select the bridge via resolveBridge");
});
