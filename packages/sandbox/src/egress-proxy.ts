// The sidecar egress proxy (spec §3.6, ADR-0010) — a REAL host-side node:http
// forward proxy that un-gates the docker backend's per-host {allow:[...]} egress
// and credential brokering. It is the real-network counterpart of the inmemory
// firewall (inmemory.ts:132-152): it enforces the allowlist, brokers a named
// credential into the OUTBOUND request at the boundary (the secret never enters
// the sandbox — only the marker name does), and records an `egress[]` audit log.
// Host-side; node:http + node:net only; zero external deps.
import http from "node:http";
import net from "node:net";
import type { CredentialBroker, NetworkPolicy, OutboundRequest } from "./backend.ts";
import { networkAllows } from "./backend.ts";

// Sandbox code names a secret BY THIS header; the proxy strips it and brokers the
// named credential. node lowercases inbound header keys, so this is the exact
// key seen in `req.headers`.
export const SECRET_HEADER = "x-iris-secret";

export interface EgressProxyOptions {
  policy: NetworkPolicy; // the allowlist enforced at the boundary
  broker?: CredentialBroker; // optional credential broker (header injection)
  host?: string; // bind address; default "127.0.0.1"
}

export interface EgressProxyHandle {
  readonly url: string; // "http://<host>:<port>" — for HTTP(S)_PROXY; never embeds creds
  readonly port: number; // the bound (possibly ephemeral) port
  readonly egress: ReadonlyArray<OutboundRequest>; // LIVE append-only audit view
  setPolicy(policy: NetworkPolicy): void; // tighten/loosen at runtime
  close(): Promise<void>;
}

// node:http delivers headers as Record<string, string | string[] | undefined>
// with lowercased keys. Flatten to the OutboundRequest's Record<string,string>:
// a multi-value header (e.g. duplicate) is joined with ", " for the audit record.
function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

// Parse the forward-proxy request target: absolute-form ("http://host/…") is the
// normal case; fall back to the Host header. Returns a BARE hostname (port
// stripped) so it feeds the exact-match `networkAllows` (allowlist entries are
// bare hostnames — see spec §5).
function parseTarget(req: http.IncomingMessage): { host: string; port: number; path: string } {
  const rawUrl = req.url ?? "";
  if (/^https?:\/\//i.test(rawUrl)) {
    const u = new URL(rawUrl);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
      path: `${u.pathname}${u.search}` || "/",
    };
  }
  // Host-header fallback — parse via URL so a ported host and IPv6 (`[::1]:8080`)
  // are handled the same way as the absolute-form path above (a bare `split(":")`
  // mangles IPv6).
  const hostHeader = String(req.headers.host ?? "");
  try {
    const u = new URL(`http://${hostHeader}`);
    return { host: u.hostname, port: u.port ? Number(u.port) : 80, path: rawUrl || "/" };
  } catch {
    return { host: hostHeader, port: 80, path: rawUrl || "/" };
  }
}

export function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxyHandle> {
  const bindHost = opts.host ?? "127.0.0.1";
  const broker = opts.broker;
  let policy: NetworkPolicy = opts.policy;
  const egress: OutboundRequest[] = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    const { host, port, path } = parseTarget(req);

    // 1) allowlist gate — refuse loudly; do NOT forward; do NOT record egress.
    if (!networkAllows(policy, host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`egress denied: ${host}`);
      req.resume(); // drain the request body so the socket can be reused/closed
      return;
    }

    // 2) credential brokering — the marker names a secret; strip it, broker it.
    const headers = flattenHeaders(req.headers);
    const secretName = headers[SECRET_HEADER];
    delete headers[SECRET_HEADER]; // never reaches upstream
    let outbound: OutboundRequest = { host, headers };
    if (secretName !== undefined) {
      if (!broker || !broker.has(secretName)) {
        // loud REFUSAL before egress (a 403, NOT the upstream-error 502) — parity
        // with the inmemory `secret:MISSING` hard-fail. Upstream is never contacted.
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`no such secret: ${secretName}`);
        req.resume();
        return;
      }
      outbound = broker.authorize(outbound, secretName); // injects authorization
    }

    // 3) permitted to leave — record (post-authorize) and forward with the body
    //    piped through; the upstream gets EXACTLY outbound.headers, not raw inbound.
    egress.push(outbound);
    const upstream = http.request(
      { host, port, path, method: req.method, headers: outbound.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      // upstream failure AFTER egress — a bad gateway, distinct from the refusal 403
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("upstream error");
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  // CONNECT (HTTPS tunnel): TLS is end-to-end, so the proxy enforces the host
  // ALLOWLIST ONLY and cannot broker a credential here (documented; not faked).
  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    const authority = req.url ?? "";
    const [h, p] = authority.split(":");
    const host = h ?? "";
    const port = p ? Number(p) : 443;
    if (!networkAllows(policy, host)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, host, () => {
      egress.push({ host, headers: {} }); // never carries a secret on a tunnel
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Track the upstream tunnel socket so close() tears it down too — it is not a
    // server `connection`, so it would otherwise outlive a proxy shutdown (fd leak).
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => {
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
      }
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise<EgressProxyHandle>((resolve) => {
    server.listen(0, bindHost, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        url: `http://${bindHost}:${port}`,
        port,
        get egress() {
          return egress;
        },
        setPolicy(next) {
          policy = next;
        },
        close() {
          return new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          });
        },
      });
    });
  });
}
