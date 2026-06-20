// EgressProxy — the REAL sidecar egress firewall for the docker backend, proven
// here over real loopback sockets (install-free; no Docker). It reproduces the
// inmemory firewall's three guarantees — per-host allowlist, credential brokering
// at the boundary, and an `egress[]` audit log — but for a real `node:http`
// forward proxy. The container↔proxy transport is the manual docker smoke; this
// suite is the unit-scope proof. (spec §2/§4.1, ADR-0010.)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startEgressProxy, SECRET_HEADER, makeCredentialBroker } from "@iris/sandbox";

const SECRET = "sk-egress-proxy-secret-xyz";

// A fake upstream that RECORDS what it received (server-side) and replies with a
// FIXED body — it does NOT echo headers, so "the secret never returns to the
// client" is a meaningful assertion (the proxy adds the secret to the UPSTREAM
// request only; the response carries none).
function makeUpstream(): Promise<{
  port: number;
  received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// A forward-proxy request: path is the ABSOLUTE target URL, host points at the
// proxy — node emits `GET http://target/… HTTP/1.1` to the proxy (forward form).
function proxyRequest(
  proxyPort: number,
  target: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: opts.method ?? "GET",
        path: target,
        headers: { host: u.host, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// A CONNECT through the proxy: resolves with the proxy's handshake status. node
// fires `connect` on a 2xx tunnel and `response` on a non-2xx refusal.
function proxyConnect(proxyPort: number, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: "CONNECT", host: "127.0.0.1", port: proxyPort, path: authority });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    req.on("error", reject);
    req.end();
  });
}

test("egress-proxy: allowed host, no secret → 200; egress records it without authorization", async () => {
  const up = await makeUpstream();
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/hello`);
    assert.equal(r.status, 200);
    assert.equal(proxy.egress.length, 1);
    assert.equal(proxy.egress[0].host, "127.0.0.1");
    assert.equal(proxy.egress[0].headers.authorization, undefined);
    assert.equal(up.received.length, 1);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: allowed host + x-iris-secret → secret brokered to UPSTREAM, never to the client; marker stripped", async () => {
  const up = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/data`, {
      headers: { [SECRET_HEADER]: "API_KEY" },
    });
    assert.equal(r.status, 200);
    // arrived upstream, brokered:
    assert.equal(up.received[0].headers.authorization, `Bearer ${SECRET}`);
    // the marker never reached upstream:
    assert.equal(up.received[0].headers[SECRET_HEADER], undefined);
    // the host-side audit log carries it (parity with inmemory egress[]):
    assert.ok(JSON.stringify(proxy.egress[0]).includes(SECRET), "egress audit carries the brokered secret");
    // the secret is in NO client-visible surface: not in the response body…
    assert.equal(r.body.includes(SECRET), false, "secret must not return to the client");
    // …and the client only ever sent the NAME, never the value (by construction).
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: a non-allowlisted host → 403; nothing egresses; upstream never contacted", async () => {
  const up = await makeUpstream();
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://blocked.invalid/x`);
    assert.equal(r.status, 403);
    assert.match(r.body, /egress denied/i);
    assert.equal(proxy.egress.length, 0);
    assert.equal(up.received.length, 0);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: unknown secret (to an ALLOWED host) → 403 refusal; egress 0; upstream never contacted", async () => {
  const up = await makeUpstream();
  const broker = makeCredentialBroker({}); // holds nothing
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/data`, {
      headers: { [SECRET_HEADER]: "MISSING" },
    });
    assert.equal(r.status, 403); // a refusal — distinct from an upstream-error 502
    assert.match(r.body, /no such secret/i);
    assert.equal(proxy.egress.length, 0);
    assert.equal(up.received.length, 0, "must not contact upstream on an unknown secret");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: setPolicy tightens AND loosens at runtime", async () => {
  const up = await makeUpstream();
  const target = `http://127.0.0.1:${up.port}/`;
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  try {
    assert.equal((await proxyRequest(proxy.port, target)).status, 200);
    proxy.setPolicy("deny-all"); // tighten
    assert.equal((await proxyRequest(proxy.port, target)).status, 403);
    proxy.setPolicy({ allow: ["127.0.0.1"] }); // loosen
    assert.equal((await proxyRequest(proxy.port, target)).status, 200);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: CONNECT is allowlist-gated (allowed → 200 established; blocked → 403)", async () => {
  const up = await makeUpstream(); // its listening socket accepts the raw TCP tunnel
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  try {
    assert.equal(await proxyConnect(proxy.port, `127.0.0.1:${up.port}`), 200);
    assert.equal(await proxyConnect(proxy.port, `blocked.invalid:443`), 403);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress-proxy: close() releases the port (a fresh listener rebinds)", async () => {
  const proxy = await startEgressProxy({ policy: "allow-all", host: "127.0.0.1" });
  const port = proxy.port;
  await proxy.close();
  await new Promise<void>((resolve, reject) => {
    const s = http.createServer();
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
});

test("egress-proxy: close() tears down an active CONNECT tunnel's upstream socket (no fd leak)", async () => {
  const accepted: net.Socket[] = [];
  const target = net.createServer((sock) => accepted.push(sock));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const tport = (target.address() as net.AddressInfo).port;
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  // open a CONNECT tunnel and KEEP it open
  const client = http.request({ method: "CONNECT", host: "127.0.0.1", port: proxy.port, path: `127.0.0.1:${tport}` });
  const clientSock: net.Socket = await new Promise((resolve) => {
    client.on("connect", (_res, socket) => resolve(socket));
    client.end();
  });
  // wait until the target has accepted the proxy's upstream connection
  await new Promise<void>((resolve) => {
    const i = setInterval(() => {
      if (accepted.length) {
        clearInterval(i);
        resolve();
      }
    }, 5);
  });
  // resolves ONLY if close() actually destroyed the upstream tunnel socket
  const upstreamClosed = new Promise<void>((resolve) => accepted[0].once("close", () => resolve()));
  await proxy.close();
  await upstreamClosed;
  clientSock.destroy();
  await new Promise<void>((r) => target.close(() => r()));
});

test("egress-proxy: a POST body is piped to upstream intact, alongside the brokered credential", async () => {
  const up = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  const payload = JSON.stringify({ hello: "world", n: 42 });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/submit`, {
      method: "POST",
      headers: { [SECRET_HEADER]: "API_KEY", "content-type": "application/json" },
      body: payload,
    });
    assert.equal(r.status, 200);
    assert.equal(up.received[0].method, "POST");
    assert.equal(up.received[0].body, payload, "body bytes piped through unchanged");
    assert.equal(up.received[0].headers.authorization, `Bearer ${SECRET}`);
  } finally {
    await proxy.close();
    await up.close();
  }
});
