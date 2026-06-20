// Adversarial review of the sandbox security spine (roadmap v0.2 P2 #8; see
// docs/reference/security-sandbox-threat-model.md). Proves the egress firewall is
// FAIL-CLOSED against bypass attempts
// and that a brokered secret never escapes to any sandbox-visible surface, the
// upstream marker, the response, or a CONNECT tunnel. Also pins the host-
// normalization hardening that makes the HTTP and CONNECT paths enforce the
// allowlist IDENTICALLY. Install-free (loopback only; no Docker, no external
// network — "allowed but unreachable" hosts use the RFC-2606 `.invalid` TLD so a
// gate-PASS is observed without requiring a successful upstream).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  startEgressProxy,
  SECRET_HEADER,
  makeCredentialBroker,
  createInMemorySession,
  networkAllows,
  normalizeHost,
} from "@irisrun/sandbox";

const SECRET = "sk-adversarial-secret-do-not-leak-9f3";

// ── helpers (mirror tests/sandbox-egress-proxy.test.ts idiom) ────────────────

function makeUpstream(): Promise<{
  port: number;
  received: Array<{ headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received.push({ headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, received, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function proxyRequest(
  proxyPort: number,
  target: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
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
    req.end();
  });
}

// Resolves with the proxy's CONNECT handshake status (200 tunnel / 403 refusal /
// 502 unreachable-after-gate-pass).
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

// ════════════════════════════════════════════════════════════════════════════
// Group 3 — normalization unit pins (no network)
// ════════════════════════════════════════════════════════════════════════════

test("adversarial/normalizeHost: folds only DNS-equivalent forms (case, IPv6 brackets, trailing dot)", () => {
  const cases: Array<[string, string]> = [
    ["api.example.com", "api.example.com"], // already normal — identity
    ["API.Example.COM", "api.example.com"], // case
    ["[::1]", "::1"], // IPv6 brackets stripped
    ["::1", "::1"], // bare IPv6 — identity
    ["[2001:DB8::1]", "2001:db8::1"], // case + brackets
    ["example.com.", "example.com"], // single trailing dot
    ["EXAMPLE.COM.", "example.com"], // case + trailing dot
    ["127.0.0.1", "127.0.0.1"], // IPv4 — identity
    ["", ""], // empty — total, no throw
    [".", "."], // lone dot — not reduced to ""
    ["[]", "[]"], // not a valid bracket pair to strip (len 2 but empty inner) → keep
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeHost(input), expected, `normalizeHost(${JSON.stringify(input)})`);
  }
});

test("adversarial/networkAllows: deny-all/allow-all/allowlist honor host normalization", () => {
  // deny-all denies every form; allow-all allows every form
  assert.equal(networkAllows("deny-all", "api.example.com"), false);
  assert.equal(networkAllows("allow-all", "API.EXAMPLE.COM"), true);
  // allowlist matches across case / trailing dot / IPv6 brackets, both directions
  assert.equal(networkAllows({ allow: ["api.example.com"] }, "API.EXAMPLE.COM"), true);
  assert.equal(networkAllows({ allow: ["API.EXAMPLE.COM"] }, "api.example.com"), true); // mis-cased entry footgun closed
  assert.equal(networkAllows({ allow: ["api.example.com."] }, "api.example.com"), true);
  assert.equal(networkAllows({ allow: ["api.example.com"] }, "api.example.com."), true);
  assert.equal(networkAllows({ allow: ["::1"] }, "[::1]"), true); // entry bare, request bracketed
  assert.equal(networkAllows({ allow: ["[::1]"] }, "[::1]"), true);
  // genuinely different hosts never match (fail-closed)
  assert.equal(networkAllows({ allow: ["api.example.com"] }, "evil.example.com"), false);
  assert.equal(networkAllows({ allow: ["api.example.com"] }, "api.example.com.evil.com"), false);
  assert.equal(networkAllows({ allow: ["example.com"] }, "sub.example.com"), false);
});

// ════════════════════════════════════════════════════════════════════════════
// Group 1 — egress-bypass attempts (gate decisions are decoupled from upstream
// reachability: DENIED ⇒ 403 + zero egress; gate-PASS ⇒ egress recorded /
// not-403, even when the allowlisted host is unreachable `.invalid`).
// ════════════════════════════════════════════════════════════════════════════

test("adversarial/bypass: CONNECT case-variant host now enforces like HTTP (the asymmetry fix)", async () => {
  // Pre-fix the CONNECT path used a raw split with no lowercasing, so an
  // upper-case authority to an allowlisted host was FALSE-DENIED (403). Post-fix
  // it normalizes via URL+normalizeHost like the HTTP path → gate PASSES.
  const proxy = await startEgressProxy({ policy: { allow: ["allowed.invalid"] }, host: "127.0.0.1" });
  try {
    const upper = await proxyConnect(proxy.port, "ALLOWED.INVALID:443");
    assert.notEqual(upper, 403, "upper-case CONNECT authority must pass the gate (asymmetry closed)");
    const lower = await proxyConnect(proxy.port, "allowed.invalid:443");
    assert.notEqual(lower, 403, "lower-case CONNECT authority must pass the gate");
    // a genuinely different host is still refused on CONNECT
    const blocked = await proxyConnect(proxy.port, "blocked.invalid:443");
    assert.equal(blocked, 403, "non-allowlisted CONNECT host must be 403");
  } finally {
    await proxy.close();
  }
});

test("adversarial/bypass: HTTP case-variant + mis-cased allowlist entry both pass the gate", async () => {
  const proxy = await startEgressProxy({ policy: { allow: ["ALLOWED.INVALID"] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, "http://allowed.invalid/x");
    assert.notEqual(r.status, 403, "mis-cased allowlist entry must still match (footgun closed)");
    assert.equal(proxy.egress.length, 1, "gate-pass records egress before forwarding");
  } finally {
    await proxy.close();
  }
});

test("adversarial/bypass: a different host dressed up (userinfo, Host override, subdomain, suffix) is always 403", async () => {
  const proxy = await startEgressProxy({ policy: { allow: ["allowed.invalid"] }, host: "127.0.0.1" });
  try {
    // userinfo before @ does NOT grant the allowlisted host — hostname is what's after @
    const userinfo = await proxyRequest(proxy.port, "http://allowed.invalid@blocked.invalid/");
    assert.equal(userinfo.status, 403, "userinfo trick must not bypass");
    // Host header cannot override the absolute-form target
    const hostOverride = await proxyRequest(proxy.port, "http://blocked.invalid/", {
      headers: { host: "allowed.invalid" },
    });
    assert.equal(hostOverride.status, 403, "Host header must not override the absolute target");
    // subdomain and suffix are different hosts
    const sub = await proxyRequest(proxy.port, "http://sub.allowed.invalid/");
    assert.equal(sub.status, 403, "subdomain is a different host");
    const suffix = await proxyRequest(proxy.port, "http://allowed.invalid.blocked.invalid/");
    assert.equal(suffix.status, 403, "suffix-appended host is a different host");
    assert.equal(proxy.egress.length, 0, "no denied request egresses");
  } finally {
    await proxy.close();
  }
});

test("adversarial/bypass: trailing-dot FQDN matches in both directions", async () => {
  // entry without dot, request with dot
  const p1 = await startEgressProxy({ policy: { allow: ["allowed.invalid"] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(p1.port, "http://allowed.invalid./y");
    assert.notEqual(r.status, 403);
    assert.equal(p1.egress.length, 1);
    assert.equal(p1.egress[0].host, "allowed.invalid", "forwarded host is normalized (dot stripped)");
  } finally {
    await p1.close();
  }
  // entry with dot, request without dot
  const p2 = await startEgressProxy({ policy: { allow: ["allowed.invalid."] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(p2.port, "http://allowed.invalid/z");
    assert.notEqual(r.status, 403);
    assert.equal(p2.egress.length, 1);
  } finally {
    await p2.close();
  }
});

test("adversarial/bypass: IPv6 + port — denied IPv6 is 403; a different port to an allowed host still passes", async () => {
  const up = await makeUpstream();
  // allowlist is host-only: ANY port on an allowlisted host passes the gate
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/p`);
    assert.equal(r.status, 200, "allowed host on its actual port forwards");
    // a bracketed-IPv6 host that is NOT allowlisted is refused on CONNECT
    // (parseAuthority no longer mangles `[::1]` to `"["`); ::1 ∉ {127.0.0.1}
    const v6 = await proxyConnect(proxy.port, "[::1]:443");
    assert.equal(v6, 403, "non-allowlisted IPv6 is 403 (and not silently mis-parsed)");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("adversarial/bypass: a bracketed IPv6 authority parses to the bare host and matches an allowlisted ::1 (parseAuthority regression guard)", async () => {
  // POSITIVE guard for the CONNECT authority parse: with `::1` allowlisted, the
  // proxy must GATE-PASS `[::1]:443`. The OLD `authority.split(":")` mangled this
  // to host `"["` (∉ allowlist → false-deny 403); the URL-based parseAuthority
  // yields `::1` → allowed → gate-pass (the upstream may be unreachable → 502,
  // which is still NOT 403). Decoupled from real ::1 connectivity.
  const proxy = await startEgressProxy({ policy: { allow: ["::1"] }, host: "127.0.0.1" });
  try {
    const v6 = await proxyConnect(proxy.port, "[::1]:443");
    assert.notEqual(v6, 403, "an allowlisted IPv6 host must pass the CONNECT gate (authority parsed correctly)");
  } finally {
    await proxy.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Group 2 — secret-leak attempts
// ════════════════════════════════════════════════════════════════════════════

test("adversarial/leak: (net-new) brokered secret never enters any sandbox-visible surface despite exfil attempts", async () => {
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const s = await createInMemorySession({
    network: { allow: ["api.example.com"] },
    broker,
    env: { TOOL_MODE: "prod", NOTE: "no secrets here" },
  });
  // the sandbox references the secret only BY NAME and egresses it
  const fetched = await s.run("fetch api.example.com secret:API_KEY");
  assert.equal(fetched.exit, 0);
  // exfil attempts: echo the name, write a file, read it back, read env
  const echoed = await s.run("echo API_KEY trying to leak");
  await s.writeFile("/workspace/exfil.txt", new TextEncoder().encode("attempting to capture API_KEY value"));
  const readBack = await s.run("read /workspace/exfil.txt");
  // the brokered value appears ONLY in the host-side egress audit, nowhere else
  assert.ok(JSON.stringify(s.egress).includes(SECRET), "egress audit carries the brokered secret");
  for (const surface of [fetched.stdout, fetched.stderr, echoed.stdout, echoed.stderr, readBack.stdout]) {
    assert.equal(surface.includes(SECRET), false, "secret must not appear in any stdout/stderr");
  }
  assert.equal(JSON.stringify(s.env ?? {}).includes(SECRET), false, "secret must not be in env");
  const ws = new TextDecoder().decode(await s.readFile("/workspace/exfil.txt"));
  assert.equal(ws.includes(SECRET), false, "secret must not be writable into /workspace (sandbox never holds the value)");
});

test("adversarial/leak: (pins) marker stripped before upstream; secret brokered upstream-only; never in the response body", async () => {
  const up = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/d`, { headers: { [SECRET_HEADER]: "API_KEY" } });
    assert.equal(r.status, 200);
    assert.equal(up.received[0].headers.authorization, `Bearer ${SECRET}`, "brokered to upstream");
    assert.equal(up.received[0].headers[SECRET_HEADER], undefined, "marker stripped before upstream");
    assert.equal(r.body.includes(SECRET), false, "secret never returns to the client");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("adversarial/leak: (net-new) CONNECT tunnel carries NO secret (no brokering over TLS)", async () => {
  const up = await makeUpstream(); // doubles as a plain TCP listener for the tunnel
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    const status = await proxyConnect(proxy.port, `127.0.0.1:${up.port}`);
    assert.equal(status, 200, "tunnel to an allowlisted host is established");
    assert.equal(proxy.egress.length, 1);
    assert.deepEqual(proxy.egress[0].headers, {}, "a CONNECT tunnel records no headers — no secret possible");
    assert.equal(JSON.stringify(proxy.egress[0]).includes(SECRET), false, "no secret on a tunnel");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("adversarial/leak: unknown / empty / wrong-case secret name → 403 before egress, upstream untouched", async () => {
  // NOTE: secret NAMES are exact-match and case-SENSITIVE (broker store keys).
  // (A leading/trailing-space name like " API_KEY " is NOT tested here: HTTP
  // transport strips OWS per RFC 7230, so it resolves to the valid "API_KEY" —
  // benign, documented in docs/reference/security-sandbox-threat-model.md, not a leak.)
  const up = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    for (const name of ["NOPE", "", "api_key", "API_KEY_"]) {
      const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/`, { headers: { [SECRET_HEADER]: name } });
      assert.equal(r.status, 403, `secret name ${JSON.stringify(name)} must be refused (exact match only)`);
    }
    assert.equal(proxy.egress.length, 0, "no refused request egresses");
    assert.equal(up.received.length, 0, "upstream is never contacted on a refusal");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("adversarial/leak: prototype-pollution secret names are refused (hasOwnProperty guard)", async () => {
  const up = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "127.0.0.1" });
  try {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const r = await proxyRequest(proxy.port, `http://127.0.0.1:${up.port}/`, { headers: { [SECRET_HEADER]: name } });
      assert.equal(r.status, 403, `prototype key ${name} must not resolve to a secret`);
    }
    assert.equal(proxy.egress.length, 0);
    assert.equal(up.received.length, 0);
  } finally {
    await proxy.close();
    await up.close();
  }
});
