// Sandbox boundary types (spec §3.6, Spec 04 §5). Untrusted tool code
// runs inside a SandboxSession rooted at /workspace, with a deny-all network
// floor and credential brokering — secrets are injected ONLY at the egress
// firewall, never materialized inside the sandbox. Host-side.

// "deny-all" is the secure default; "allow-all" is open; {allow} is a host
// allowlist. (spawn() for long-running tools — Spec 04 §5 — is deferred: M3 tools
// are request/response, so only the blocking `run` is needed.)
export type NetworkPolicy = "deny-all" | "allow-all" | { allow: string[] };

export interface RunResult {
  stdout: string;
  stderr: string;
  exit: number;
}

export interface SandboxSession {
  readonly id: string;
  // Blocks until the command exits.
  run(cmd: string): Promise<RunResult>;
  // Rooted at /workspace; a path outside it is rejected.
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  setNetworkPolicy(policy: NetworkPolicy): Promise<void>;
}

export interface CreateOptions {
  network?: NetworkPolicy; // default: "deny-all"
  env?: Record<string, string>; // sandbox-visible env — NEVER secrets
  broker?: CredentialBroker;
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

/** True iff `host` may be reached under `policy`. */
export function networkAllows(policy: NetworkPolicy, host: string): boolean {
  if (policy === "deny-all") return false;
  if (policy === "allow-all") return true;
  return policy.allow.includes(host);
}
