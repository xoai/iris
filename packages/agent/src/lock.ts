// The lockfile — pins model + tools/connections (by contractDigest) +
// tactics + capabilities + the embedded content hashes. `imageDigest` is filled by
// the image build. This module owns the tool-resolution + pinning + the
// capability validation; Task 4 completes content/model/tactics. Host-side.
import { contractDigest, type ToolContract } from "@irisrun/tools";
import type { CapabilityProfile, ToolRef } from "./agentfile.ts";
import type { RegistryResolver } from "./resolver.ts";

// A lock tool carries the model-perceived contractDigest (what a session pins) +
// the floating realization (transport/location/retrySafe). `in-process` is NOT a
// lock transport — an Agentfile cannot author it. `ref` is the STABLE
// Agentfile registry handle (e.g. `mcp://registry/x@^2`) — the key to re-resolve
// the contract at verify time; `location` is the CURRENT deploy and FLOATS
// independently, so verify must re-resolve by `ref`, never `location`.
export interface LockTool {
  name: string;
  ref: string;
  contractDigest: string;
  transport: "mcp" | "grpc" | "subprocess";
  location: string;
  retrySafe: boolean;
}

export interface Lock {
  imageDigest: string;
  model: { id: string; digest?: string };
  content: Record<string, string>; // path → sha256
  tools: LockTool[];
  tactics: Record<string, { id: string; digest: string }>;
  capabilities: CapabilityProfile;
}

/**
 * Resolve each ref to a concrete contract and pin it. A ref that resolves to
 * nothing → loud dangling-ref error; a resolver returning an `in-process`
 * contract for an Agentfile ref → loud reject (in-process is not authorable, so
 * the lock's `mcp|grpc|subprocess` union stays sound).
 */
export async function resolveLockTools(
  refs: ToolRef[],
  resolver: RegistryResolver,
): Promise<LockTool[]> {
  const out: LockTool[] = [];
  for (const { ref } of refs) {
    const contract = await resolver.resolve(ref);
    if (contract === null) {
      throw new Error(`build: dangling tool ref — "${ref}" did not resolve to a contract`);
    }
    if (contract.transport === "in-process") {
      throw new Error(
        `build: tool ref "${ref}" resolved to an in-process contract, which is not authorable in an Agentfile (use mcp/grpc/subprocess)`,
      );
    }
    out.push({
      name: contract.name,
      ref, // the stable registry handle — re-resolved by verify (location floats)
      contractDigest: contractDigest(contract),
      transport: contract.transport,
      location: contract.location,
      retrySafe: contract.retrySafe,
    });
  }
  return out;
}

/**
 * Validate the capability profile against the resolved tools,
 * loudly (no silent inconsistency): a `remote` locality forbids subprocess tools,
 * and any subprocess tool requires `local_subprocess: true`.
 */
export function validateCapabilities(
  requires: CapabilityProfile,
  tools: LockTool[],
): void {
  const hasSubprocess = tools.some((t) => t.transport === "subprocess");
  if (requires.tool_locality === "remote" && hasSubprocess) {
    throw new Error(
      `build: capability profile is inconsistent — tool_locality "remote" forbids subprocess:// tools`,
    );
  }
  if (hasSubprocess && requires.local_subprocess !== true) {
    throw new Error(
      `build: a subprocess:// tool requires the "local_subprocess" capability, but requires.local_subprocess is not true`,
    );
  }
}

// Type guard usable by Task 5/6 (re-exported via index).
export type { ToolContract };
