// The docker sandbox backend (spec §3.6, ADR-0010) — REAL isolation via the
// `docker` CLI: `docker run --network none` by default with a /workspace volume.
// Host-side (node:child_process + node:fs). Docker is unavailable in the install-
// free unit env, so this backend is exercised by `manual/docker-smoke.ts` only;
// it is still typechecked here. Credential brokering at real network egress
// needs a sidecar egress proxy — secrets are NEVER passed as `-e`/args/volume
// (that is the secure invariant the manual smoke asserts).
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

const DEFAULT_IMAGE = "alpine:3";
const DEFAULT_TIMEOUT_MS = 60_000;
const WORKSPACE = "/workspace";

export interface DockerCreateOptions extends CreateOptions {
  image?: string;
  timeoutMs?: number;
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

// Per-host allowlisting needs a sidecar egress proxy (deferred, spec §3.6). The
// docker backend supports ONLY the explicit "deny-all" and "allow-all". A
// `{allow:[...]}` policy is REFUSED LOUDLY rather than silently granting open
// egress (no-silent-failures / secure floor) — silently mapping it to `bridge`
// would give a caller who asked for restriction full unrestricted egress.
function assertDockerPolicy(policy: NetworkPolicy): void {
  if (policy !== "deny-all" && policy !== "allow-all") {
    throw new Error(
      `docker sandbox: per-host network allowlist (${JSON.stringify(policy.allow)}) requires an egress proxy (not yet supported); use "deny-all" or "allow-all" explicitly`,
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
  let policy: NetworkPolicy = opts.network ?? "deny-all";
  assertDockerPolicy(policy); // fail early on an unsupported allowlist (before any side effect)
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
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return execDocker(
        [
          "run",
          "--rm",
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
      assertDockerPolicy(next); // refuse an unsupported allowlist loudly
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
