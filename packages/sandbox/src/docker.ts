// The docker sandbox backend (spec §3.6) — REAL isolation via the
// `docker` CLI: `docker run --network none` by default with a /workspace volume.
// Host-side (node:child_process + node:fs). Docker is unavailable in the install-
// free unit env, so this backend is exercised by `tests/manual/docker-smoke.ts` only;
// it is still typechecked here. Real per-host {allow} egress + credential
// brokering are UN-GATED via the sidecar `EgressProxy`: pass `egress` and the
// container is routed through it (HTTP(S)_PROXY). Secrets are NEVER passed as
// `-e`/args/volume — they are brokered at the proxy (host-side), so they never
// enter the container (the secure invariant the manual smoke asserts).
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type {
  CreateOptions,
  NetworkPolicy,
  RunResult,
  SandboxBackend,
  SandboxSession,
} from "./backend.ts";
import type { EgressProxyHandle } from "./egress-proxy.ts";

const DEFAULT_IMAGE = "alpine:3";
const DEFAULT_TIMEOUT_MS = 60_000;
const WORKSPACE = "/workspace";

export interface DockerCreateOptions extends CreateOptions {
  image?: string;
  timeoutMs?: number;
  // When present, a per-host {allow:[...]} policy is accepted and the container
  // is routed through this proxy (which enforces the allowlist + brokers
  // credentials, host-side). Without it, {allow} is refused loudly.
  egress?: EgressProxyHandle;
}

export function dockerBackend(defaults: { image?: string } = {}): SandboxBackend {
  return {
    name: "docker",
    create: (opts) => createDockerSession({ image: defaults.image, ...opts }),
    prewarm: async (tag) => {
      const r = await execDocker(["pull", tag], DEFAULT_TIMEOUT_MS);
      if (r.exit !== 0) {
        // no-silent-failures: a failed pull must not look like a successful prewarm
        throw new Error(
          `docker prewarm: \`docker pull ${tag}\` failed (exit ${r.exit})${
            r.stderr.trim() ? `: ${r.stderr.trim()}` : ""
          }`,
        );
      }
    },
  };
}

// A per-host `{allow:[...]}` policy is accepted IFF an egress proxy is wired
// (`hasProxy`); otherwise it is REFUSED LOUDLY rather than silently granting open
// egress (no-silent-failures / secure floor) — silently mapping it to `bridge`
// would give a caller who asked for restriction full unrestricted egress. With a
// proxy, the allowlist is enforced AT the proxy (host-side) and the container is
// routed through it. `deny-all`/`allow-all` are always accepted.
function assertDockerPolicy(policy: NetworkPolicy, hasProxy: boolean): void {
  if (policy !== "deny-all" && policy !== "allow-all" && !hasProxy) {
    throw new Error(
      `docker sandbox: per-host network allowlist (${JSON.stringify(policy.allow)}) requires an egress proxy (pass createDockerSession({ …, egress }) from startEgressProxy); use "deny-all" or "allow-all" explicitly to run without one`,
    );
  }
}

// Map the supported NetworkPolicy onto docker's --network flag. deny-all (the
// secure floor) → `none`; allow-all → `bridge`. (Allowlists are rejected by
// assertDockerPolicy at create/setNetworkPolicy, so they never reach here.)
function dockerNetwork(policy: NetworkPolicy): string {
  return policy === "deny-all" ? "none" : "bridge";
}

export async function createDockerSession(
  opts: DockerCreateOptions = {},
): Promise<SandboxSession> {
  const image = opts.image ?? DEFAULT_IMAGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Record<string, string> = { ...(opts.env ?? {}) }; // NEVER secrets
  const proxy = opts.egress;
  // hasProxy is FIXED at create and immutable for the session's life — there is no
  // setNetworkPolicy(handle) path to grant a proxy later, so a no-proxy session
  // can never accept {allow}. Threaded into BOTH assertDockerPolicy call sites.
  const hasProxy = proxy !== undefined;
  let policy: NetworkPolicy = opts.network ?? "deny-all";
  assertDockerPolicy(policy, hasProxy); // fail early on an unsupported allowlist (before any side effect)
  const workspaceDir = await mkdtemp(join(tmpdir(), "iris-sbx-"));
  const id = `docker:${workspaceDir}`;

  const toHostPath = (path: string): string => {
    if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
      throw new Error(`sandbox: path "${path}" is outside ${WORKSPACE}`);
    }
    return join(workspaceDir, path.slice(WORKSPACE.length) || ".");
  };

  return {
    id,
    async run(cmd) {
      // Route a {allow} container through the sidecar proxy. The proxy URL is NOT
      // a secret (host:port only) — it is injected as HTTP(S)_PROXY so well-behaved
      // clients egress via the proxy, which enforces the allowlist + brokers
      // credentials. NOTE (honest enforcement): --network=bridge + HTTP_PROXY is
      // COOPERATIVE — a tool that ignores the proxy env can still reach the bridge.
      // Hard enforcement (the proxy as the sole egress) is a deployment concern
      // (internal network / firewall); the secure FLOOR (no-proxy {allow} refused,
      // deny-all = no network) is unchanged.
      const routing: Record<string, string> = {};
      const extraArgs: string[] = [];
      if (typeof policy === "object" && proxy) {
        const proxyUrl = `http://host.docker.internal:${proxy.port}`;
        routing.HTTP_PROXY = proxyUrl;
        routing.HTTPS_PROXY = proxyUrl;
        routing.http_proxy = proxyUrl;
        routing.https_proxy = proxyUrl;
        extraArgs.push("--add-host=host.docker.internal:host-gateway");
      }
      const envArgs = Object.entries({ ...env, ...routing }).flatMap(([k, v]) => [
        "-e",
        `${k}=${v}`,
      ]);
      return execDocker(
        [
          "run",
          "--rm",
          ...extraArgs,
          `--network=${dockerNetwork(policy)}`,
          "-v",
          `${workspaceDir}:${WORKSPACE}`,
          "-w",
          WORKSPACE,
          ...envArgs,
          image,
          "sh",
          "-c",
          cmd,
        ],
        timeoutMs,
      );
    },
    async readFile(path) {
      return new Uint8Array(await fsReadFile(toHostPath(path)));
    },
    async writeFile(path, bytes) {
      const host = toHostPath(path);
      await mkdir(dirname(host), { recursive: true });
      await fsWriteFile(host, bytes);
    },
    async setNetworkPolicy(next) {
      assertDockerPolicy(next, hasProxy); // refuse {allow} loudly unless this session has a proxy
      policy = next;
    },
  };
}

function execDocker(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exit: code });
      },
    );
  });
}
