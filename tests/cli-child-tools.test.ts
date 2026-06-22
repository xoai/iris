// Subagent child tool-transport parity (wiring fix): a delegated child's invoker
// wires subprocess + mcp + http (configs beside the child's layout), zero-value-off.
// Pre-fix the child got subprocess only, so a child with http:// (or mcp://) tools
// failed with no_transport. Verified behaviorally against a loopback node:http server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childToolWiring } from "iris-runtime";
import type { ToolContract } from "@irisrun/tools";

async function loopback(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pong: true }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    }),
  );
}

const httpContract: ToolContract = {
  name: "ping", description: "", inputSchema: {}, transport: "http", location: "http://api/ping", retrySafe: true,
};

test("a child invoker wires the http transport when openapi.json is present", async () => {
  const srv = await loopback();
  const root = await mkdtemp(join(tmpdir(), "iris-child-"));
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1" }, paths: { "/ping": { get: { operationId: "ping" } } } };
  await writeFile(join(root, "spec.json"), JSON.stringify(spec));
  await writeFile(join(root, "openapi.json"), JSON.stringify([{ name: "api", spec: "spec.json", baseUrl: srv.baseUrl }]));
  const { toolInvoker } = await childToolWiring(join(root, "image"));
  const r = await toolInvoker.invoke(httpContract, {});
  assert.deepEqual(r, { ok: true, value: { pong: true } });
  await srv.close();
});

test("a child invoker without openapi.json does NOT wire http (zero-value-off → no_transport)", async () => {
  const root = await mkdtemp(join(tmpdir(), "iris-child-empty-"));
  const { toolInvoker } = await childToolWiring(join(root, "image"));
  const r = await toolInvoker.invoke(httpContract, {});
  assert.equal(r.ok, false);
});
