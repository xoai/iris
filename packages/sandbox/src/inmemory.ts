// The inmemory sandbox backend (spec §3.6) — carries the unit suite. /workspace
// is an in-memory map; network defaults to deny-all; `run` executes a small
// deterministic command allowlist. Network egress goes through a firewall that
// consults the policy and the credential broker, so a secret is brokered at the
// boundary and never materializes inside the sandbox. Host-side; no node: APIs.
import type {
  CredentialBroker,
  NetworkPolicy,
  OutboundRequest,
  RunResult,
  SandboxBackend,
  SandboxSession,
  CreateOptions,
} from "./backend.ts";
import { networkAllows } from "./backend.ts";

const WORKSPACE = "/workspace";

// A counter for deterministic-but-unique session ids (no clock/RNG in core; this
// is host-side test infra, so a module counter is fine).
let sessionCounter = 0;

// The inmemory session also exposes egress + env for assertions (T8). The egress
// array is the firewall's record of what LEFT the box (it carries brokered
// secrets); the sandbox surfaces (env, /workspace, stdout) never do.
export interface InMemorySession extends SandboxSession {
  readonly egress: ReadonlyArray<OutboundRequest>;
  readonly env: Readonly<Record<string, string>>;
}

export function createInMemorySession(
  opts: CreateOptions = {},
): Promise<InMemorySession> {
  let policy: NetworkPolicy = opts.network ?? "deny-all";
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  const broker: CredentialBroker | undefined = opts.broker;
  const workspace = new Map<string, Uint8Array>();
  const egress: OutboundRequest[] = [];
  const id = `inmemory-${sessionCounter++}`;

  const ensureWorkspacePath = (path: string): void => {
    if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
      throw new Error(`sandbox: path "${path}" is outside ${WORKSPACE}`);
    }
  };

  const session: InMemorySession = {
    id,
    get egress() {
      return egress;
    },
    get env() {
      return env;
    },
    async readFile(path) {
      ensureWorkspacePath(path);
      const bytes = workspace.get(path);
      if (bytes === undefined) {
        throw new Error(`sandbox: no such file: ${path}`);
      }
      return bytes;
    },
    async writeFile(path, bytes) {
      ensureWorkspacePath(path);
      workspace.set(path, bytes);
    },
    async setNetworkPolicy(next) {
      policy = next;
    },
    async run(cmd) {
      return runCommand(cmd, {
        policy,
        env,
        broker,
        workspace,
        egress,
      });
    },
  };
  return Promise.resolve(session);
}

interface RunContext {
  policy: NetworkPolicy;
  env: Record<string, string>;
  broker: CredentialBroker | undefined;
  workspace: Map<string, Uint8Array>;
  egress: OutboundRequest[];
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exit: 0 });
const fail = (stderr: string, exit = 1): RunResult => ({ stdout: "", stderr, exit });

// A tiny deterministic command language for the unit suite:
//   echo <text...>            → stdout the text
//   write <path> <text...>    → write to /workspace
//   read <path>               → stdout the file
//   fetch <host> [secret:<n>] → egress through the firewall (policy + broker)
function runCommand(cmd: string, ctx: RunContext): RunResult {
  const parts = cmd.trim().split(/\s+/);
  const verb = parts[0] ?? "";
  switch (verb) {
    case "echo":
      return ok(parts.slice(1).join(" "));
    case "write": {
      const path = parts[1];
      if (!path) return fail("write: missing path");
      try {
        if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
          return fail(`write: path "${path}" is outside ${WORKSPACE}`);
        }
        ctx.workspace.set(path, new TextEncoder().encode(parts.slice(2).join(" ")));
        return ok("");
      } catch (e) {
        return fail(`write failed: ${(e as Error).message}`);
      }
    }
    case "read": {
      const path = parts[1];
      if (!path) return fail("read: missing path");
      const bytes = ctx.workspace.get(path);
      if (bytes === undefined) return fail(`read: no such file: ${path}`);
      return ok(new TextDecoder().decode(bytes));
    }
    case "fetch":
      return runFetch(parts.slice(1), ctx);
    default:
      return fail(`unknown command: "${verb}"`);
  }
}

function runFetch(args: string[], ctx: RunContext): RunResult {
  const host = args[0];
  if (!host) return fail("fetch: missing host");
  if (!networkAllows(ctx.policy, host)) {
    return fail(`network denied: ${host}`);
  }
  const secretArg = args.find((a) => a.startsWith("secret:"));
  let request: OutboundRequest = { host, headers: {} };
  if (secretArg) {
    const secretName = secretArg.slice("secret:".length);
    if (!ctx.broker || !ctx.broker.has(secretName)) {
      // fail BEFORE egressing — no silent send without the credential
      return fail(`no such secret: ${secretName}`);
    }
    // brokered at the egress firewall — the secret enters the OUTBOUND request
    // only, never the sandbox's stdout/env/workspace.
    request = ctx.broker.authorize(request, secretName);
  }
  ctx.egress.push(request);
  return ok(`fetched ${host}`);
}

export function inMemoryBackend(): SandboxBackend {
  return {
    name: "inmemory",
    create: (opts) => createInMemorySession(opts),
  };
}
