// Sandbox boundary types. Untrusted tool code
// runs inside a SandboxSession rooted at /workspace, with a deny-all network
// floor and credential brokering — secrets are injected ONLY at the egress
// firewall, never materialized inside the sandbox. Host-side.

// "deny-all" is the secure default; "allow-all" is open; {allow} is a host
// allowlist. (spawn() for long-running tools is deferred: current tools
// are request/response, so only the blocking `run` is needed.)
export type NetworkPolicy = "deny-all" | "allow-all" | { allow: string[] };

export interface RunResult {
  stdout: string;
  stderr: string;
  exit: number;
}

// Options for a single run. `stdin` feeds the process's standard input (the tool
// request/response protocol writes a JSON line in and reads one out); `timeoutMs`
// overrides the backend default. Both optional → absent is byte-identical to the
// historical `run(cmd)` behavior.
export interface RunOpts {
  stdin?: Uint8Array;
  timeoutMs?: number;
}

// A test-facing command handler for the in-memory backend: given the run's stdin
// and the command's parsed args, return a RunResult. Lets the tool line-protocol be
// exercised in CI without a real process/Docker. (The docker backend ignores it.)
export type SandboxCommand = (stdin: Uint8Array, args: string[]) => RunResult;

export interface SandboxSession {
  readonly id: string;
  // Blocks until the command exits. `opts` is additive — `run(cmd)` is unchanged.
  run(cmd: string, opts?: RunOpts): Promise<RunResult>;
  // Rooted at /workspace; a path outside it is rejected.
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  setNetworkPolicy(policy: NetworkPolicy): Promise<void>;
}

export interface CreateOptions {
  network?: NetworkPolicy; // default: "deny-all"
  env?: Record<string, string>; // sandbox-visible env — NEVER secrets
  broker?: CredentialBroker;
  // Test-facing command handlers (in-memory backend only; docker ignores). A
  // command whose verb matches is dispatched to its handler before the built-in
  // toy verbs. Absent → today's behavior.
  commands?: Record<string, SandboxCommand>;
}

export interface SandboxBackend {
  readonly name: string;
  create(opts?: CreateOptions): Promise<SandboxSession>;
  prewarm?(tag: string): Promise<void>;
}

// An outbound request as it leaves the egress firewall (OUTSIDE the sandbox).
export interface OutboundRequest {
  host: string;
  headers: Record<string, string>;
}

// The broker holds secrets OUTSIDE the sandbox. It never returns a raw secret to
// sandbox code — it only injects a named secret into an outbound request at the
// egress firewall. `has` lets the firewall fail loudly on an unknown secret
// BEFORE anything egresses.
export interface CredentialBroker {
  has(name: string): boolean;
  authorize(request: OutboundRequest, secretName: string): OutboundRequest;
}

/**
 * A credential broker over an in-process secret map. The secret values live only
 * here (host-side); `authorize` adds the secret to an outbound request's headers
 * at egress and is the ONLY path a secret can leave by — there is no getter that
 * hands a raw secret to sandbox code.
 */
export function makeCredentialBroker(
  secrets: Record<string, string>,
): CredentialBroker {
  const store: Record<string, string> = { ...secrets };
  return {
    has: (name) => Object.prototype.hasOwnProperty.call(store, name),
    authorize: (request, secretName) => {
      const value = store[secretName];
      if (value === undefined) {
        throw new Error(`credential broker: no secret named "${secretName}"`);
      }
      return {
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${value}` },
      };
    },
  };
}

/**
 * Canonicalize a hostname for allowlist comparison so the allowlist enforces
 * IDENTICALLY regardless of case/format and across every enforcement path
 * (proxy HTTP, proxy CONNECT, inmemory firewall). It folds only DNS-EQUIVALENT
 * forms — lowercase (DNS is case-insensitive); strip ONE surrounding pair of
 * IPv6 brackets (`[::1]` === `::1`); strip a single trailing dot (`a.com.` ===
 * `a.com`, the FQDN root label). It NEVER broadens an entry to a genuinely
 * different host, so the allowlist stays fail-closed. Deliberately NOT
 * IDNA/punycode: allowlist entries are expected to be pre-normalized ASCII, and
 * the proxy applies request-side IDNA folding (`URL.hostname`) as an additional
 * one-way hardening before this. Pure, total, never throws. (Strips ANY single
 * surrounding bracket pair; in practice only an IPv6 literal reaches here. See
 * docs/reference/security-sandbox-threat-model.md.)
 */
export function normalizeHost(raw: string): string {
  let h = raw.toLowerCase();
  if (h.length > 2 && h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1); // non-empty IPv6 literal: [::1] → ::1
  }
  if (h.length > 1 && h.endsWith(".")) {
    h = h.slice(0, -1); // single trailing FQDN dot
  }
  return h;
}

/** True iff `host` may be reached under `policy` (host-normalized; see
 * docs/reference/security-sandbox-threat-model.md). */
export function networkAllows(policy: NetworkPolicy, host: string): boolean {
  if (policy === "deny-all") return false;
  if (policy === "allow-all") return true;
  const h = normalizeHost(host);
  return policy.allow.some((entry) => normalizeHost(entry) === h);
}
