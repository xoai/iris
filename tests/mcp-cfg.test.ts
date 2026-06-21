// loadMcpServers (packages/cli/src/mcp-cfg.ts): parse an mcp.json into the handle→spec
// map the MCP transport looks up, with loud validation; a missing file is empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServers } from "../packages/cli/src/mcp-cfg.ts";

function write(content: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "iris-mcp-cfg-")), "mcp.json");
  writeFileSync(f, content);
  return f;
}

test("loadMcpServers: a missing file is an empty map (zero-value-off)", async () => {
  assert.deepEqual(await loadMcpServers(join(tmpdir(), "iris-no-such-mcp-xyz.json")), {});
});

test("loadMcpServers: valid config → handle → spec map", async () => {
  const f = write(
    JSON.stringify([
      { name: "registry/mem0", command: "npx", args: ["-y", "mem0-mcp"] },
      { name: "local/cache", command: "node" },
    ]),
  );
  assert.deepEqual(await loadMcpServers(f), {
    "registry/mem0": { command: "npx", args: ["-y", "mem0-mcp"] },
    "local/cache": { command: "node" },
  });
});

test("loadMcpServers: invalid JSON → loud", async () => {
  await assert.rejects(loadMcpServers(write("{not json")), /invalid JSON/);
});
test("loadMcpServers: a non-array → loud", async () => {
  await assert.rejects(loadMcpServers(write(JSON.stringify({ name: "x" }))), /must be a JSON array/);
});
test("loadMcpServers: a missing name → loud", async () => {
  await assert.rejects(loadMcpServers(write(JSON.stringify([{ command: "node" }]))), /needs a non-empty string "name"/);
});
test("loadMcpServers: a missing command → loud", async () => {
  await assert.rejects(loadMcpServers(write(JSON.stringify([{ name: "x" }]))), /needs a non-empty string "command"/);
});
test("loadMcpServers: bad args → loud", async () => {
  await assert.rejects(
    loadMcpServers(write(JSON.stringify([{ name: "x", command: "node", args: "nope" }]))),
    /"args" must be an array of strings/,
  );
});
test("loadMcpServers: a duplicate name → loud", async () => {
  await assert.rejects(
    loadMcpServers(write(JSON.stringify([{ name: "x", command: "a" }, { name: "x", command: "b" }]))),
    /duplicate server name/,
  );
});
