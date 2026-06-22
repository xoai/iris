// C1 (openapi-transport): the `http` tool transport. One operation-tool = one HTTP
// call — method/path/query/body mapped from input, a named secret on the
// Authorization header (never in the URL), response JSON → ToolResult. Tested against
// a loopback node:http server (pattern: tests/sandbox-egress-proxy.test.ts makeUpstream).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeHttpTransport } from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";

interface Recorded { method?: string; url?: string; auth?: string | string[]; body: string }

async function makeServer(
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ baseUrl: string; received: Recorded[]; close: () => Promise<void> }> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, auth: req.headers["authorization"], body });
      reply(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const contractFor = (handle: string): ToolContract => ({
  name: handle, description: "", inputSchema: {},
  transport: "http", location: `http://${handle}`, retrySafe: true,
});

const json = (res: http.ServerResponse, code: number, value: unknown): void => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

test("GET maps {path} params + query from input; 2xx JSON body → value", async () => {
  const srv = await makeServer((req, res) => json(res, 200, { got: req.url }));
  const t = makeHttpTransport({ pets: { baseUrl: srv.baseUrl, method: "GET", path: "/pets/{id}", query: ["limit"] } });
  const r = await t.invoke(contractFor("pets"), { id: "7", limit: 3 });
  assert.deepEqual(r, { ok: true, value: { got: "/pets/7?limit=3" } });
  await srv.close();
});

test("POST sends a JSON body + an Authorization header from a named env secret (never in URL)", async () => {
  const srv = await makeServer((req, res, body) => json(res, 200, { echo: JSON.parse(body) }));
  const t = makeHttpTransport(
    { create: { baseUrl: srv.baseUrl, method: "POST", path: "/pets", authSecretEnv: "API_KEY" } },
    { env: { API_KEY: "sk-xyz" } },
  );
  const r = await t.invoke(contractFor("create"), { name: "Rex" });
  assert.deepEqual(r, { ok: true, value: { echo: { name: "Rex" } } });
  assert.equal(srv.received[0].auth, "Bearer sk-xyz");
  assert.ok(!String(srv.received[0].url).includes("sk-xyz"), "secret never in the URL");
  await srv.close();
});

test("a non-2xx response → {ok:false}, and the secret is not echoed", async () => {
  const srv = await makeServer((_req, res) => json(res, 404, { error: "nope" }));
  const t = makeHttpTransport(
    { pets: { baseUrl: srv.baseUrl, method: "GET", path: "/pets/{id}", authSecretEnv: "API_KEY" } },
    { env: { API_KEY: "sk-secret" } },
  );
  const r = await t.invoke(contractFor("pets"), { id: "1" });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("sk-secret"), "secret must not appear in the failure");
  await srv.close();
});

test("a declared auth secret with no value fails loudly — no unauthenticated call", async () => {
  const t = makeHttpTransport({ pets: { baseUrl: "http://127.0.0.1:9", method: "GET", path: "/x", authSecretEnv: "API_KEY" } });
  const r = await t.invoke(contractFor("pets"), {});
  assert.equal(r.ok, false);
});

test("a malformed-JSON 2xx body → {ok:false}", async () => {
  const srv = await makeServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not json"); });
  const t = makeHttpTransport({ x: { baseUrl: srv.baseUrl, method: "GET", path: "/" } });
  const r = await t.invoke(contractFor("x"), {});
  assert.equal(r.ok, false);
  await srv.close();
});

test("an unregistered http handle → loud {ok:false}", async () => {
  const r = await makeHttpTransport({}).invoke(contractFor("nope"), {});
  assert.equal(r.ok, false);
});

test("a connection failure → {ok:false} (request_failed)", async () => {
  // Port 1 is unused → fetch rejects (ECONNREFUSED); no auth secret, so it reaches fetch.
  const t = makeHttpTransport({ x: { baseUrl: "http://127.0.0.1:1", method: "GET", path: "/" } });
  const r = await t.invoke(contractFor("x"), {});
  assert.equal(r.ok, false);
});

test("a request that never responds → {ok:false} (timeout, no hang)", async () => {
  const srv = await makeServer(() => { /* never responds — the AbortController must fire */ });
  const t = makeHttpTransport({ x: { baseUrl: srv.baseUrl, method: "GET", path: "/" } }, { timeoutMs: 50 });
  const r = await t.invoke(contractFor("x"), {});
  assert.equal(r.ok, false);
  await srv.close();
});
