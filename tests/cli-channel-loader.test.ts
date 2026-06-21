// The pluggable --channel loader (packages/cli/src/channel.ts): the built-in "rest"
// (default) is makeRestChannel; a module specifier exporting openChannel(opts) is loaded
// and used; bad modules fail loudly. Proves a first-party-grade channel plugs into
// `iris serve` without a fork (complementing the any-language bridge pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeRestChannel } from "@irisrun/channel-rest";
import { resolveChannel } from "../packages/cli/src/channel.ts";

test("resolveChannel: default and 'rest' return the built-in makeRestChannel", async () => {
  assert.equal(await resolveChannel(undefined), makeRestChannel);
  assert.equal(await resolveChannel("rest"), makeRestChannel);
});

test("resolveChannel: a --channel <module> exporting openChannel is loaded and used", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = pathToFileURL(join(here, "lib", "fake-channel-module.ts")).href;
  const open = await resolveChannel(spec);
  // the fixture ignores opts and returns a fake handle — the loader test exercises
  // loading, not serving (channel-rest's own conformance covers the wire).
  const handle = await (open as (o?: unknown) => Promise<{ listen: () => Promise<string>; close: () => Promise<void> }>)();
  assert.equal(typeof handle.listen, "function");
  assert.equal(typeof handle.close, "function");
  assert.equal(await handle.listen(), "http://fake-channel.local:0");
});

test("resolveChannel: a module without openChannel fails loudly", async () => {
  await assert.rejects(resolveChannel("@irisrun/core"), /must export openChannel/);
});

test("resolveChannel: an unresolvable module fails loudly", async () => {
  await assert.rejects(resolveChannel("@irisrun/channel-does-not-exist-xyz"), /could not import/);
});

// Wiring guard (source assertion): cmdServe selects its channel via resolveChannel, so
// the default path goes through the loader and --channel is honoured.
test("cmdServe wires the channel through resolveChannel", () => {
  const iris = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "iris.ts"),
    "utf8",
  );
  assert.match(iris, /resolveChannel\(opts\.channel\)/, "cmdServe must select the channel via resolveChannel");
});
