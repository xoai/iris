// --sandbox activation (initiative 20260622-sandbox-runtime-wiring): build a
// SandboxExecutor from the image's Agentfile `sandbox:` block. The refusals here are
// PURE logic (CI-tested); the docker `exec` path runs only on a docker-capable
// machine (the gated smoke), never in CI.
import { dockerBackend, makeCredentialBroker } from "@irisrun/sandbox";
import type { NetworkPolicy } from "@irisrun/sandbox";
import type { SandboxExecutor } from "@irisrun/tools";
import { readFile } from "node:fs/promises";

// The image's Agentfile sandbox block (see @irisrun/agent agentfile.ts).
export interface AgentfileSandbox {
  backend: string;
  network: string;
  workspace?: string;
}

// A node image so the host `node` exec tool resolves inside the container (the
// default sandbox image alpine:3 has no node).
const NODE_IMAGE = "node:22-alpine";

// Map the Agentfile network string to a NetworkPolicy. The --sandbox slice supports
// the two simple floors; a per-host allowlist needs the egress proxy (deferred).
export function parseNetworkPolicy(network: string): NetworkPolicy {
  if (network === "deny-all" || network === "allow-all") return network;
  throw new Error(
    `--sandbox: network "${network}" is not supported yet (use "deny-all" or "allow-all"; per-host allowlists need the egress proxy)`,
  );
}

export function buildSandboxExecutor(
  sandbox: AgentfileSandbox,
  secrets: Record<string, string> = {},
): SandboxExecutor {
  if (sandbox.backend === "inmemory") {
    throw new Error(
      `--sandbox: backend "inmemory" is a test backend and cannot execute real tools; build the image with sandbox.backend: "docker"`,
    );
  }
  if (sandbox.backend !== "docker") {
    throw new Error(`--sandbox: unknown backend "${sandbox.backend}" (supported: "docker")`);
  }
  const policy = parseNetworkPolicy(sandbox.network);
  // A broker is only useful when egress is allowed — under deny-all no request ever
  // leaves, so there's nothing to broker (matches the spec's stated intent).
  const broker =
    policy !== "deny-all" && Object.keys(secrets).length > 0
      ? makeCredentialBroker(secrets)
      : undefined;
  const backend = dockerBackend({ image: NODE_IMAGE });
  return {
    async exec(spec, stdin, timeoutMs) {
      // This slice supports only single-file node exec tools (the `iris init` shape:
      // { command: process.execPath, args: ["<tool>.mjs"] }). Anything else is refused
      // loudly BEFORE touching docker — so these refusals are CI-testable.
      if (spec.command !== process.execPath) {
        throw new Error(
          `--sandbox: only node exec tools are supported in this slice (command "${spec.command}" is not the node runtime)`,
        );
      }
      const files = spec.args ?? [];
      if (files.length !== 1) {
        throw new Error(
          `--sandbox: only single-file tools are supported in this slice (got ${files.length} args)`,
        );
      }
      // Stage the tool file into /workspace, then run it with the node interpreter.
      // (Docker — smoke-only; not reached in CI.)
      const session = await backend.create({ network: policy, env: spec.env, broker });
      const hostPath = files[0]!;
      const base = hostPath.split(/[\\/]/).pop() || "tool.mjs";
      const dest = `/workspace/${base}`;
      await session.writeFile(dest, new Uint8Array(await readFile(hostPath)));
      return session.run(`node ${dest}`, { stdin, timeoutMs });
    },
  };
}
