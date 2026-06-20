// ToolContract + contractDigest (spec §3.2, Spec 05 A1). Host-side: MAY use
// node:crypto (not core). The digest covers the MODEL-PERCEIVED surface only —
// transport/location/retrySafe float (ADR-0004) — and reuses @irisrun/core's
// canonicalize for deterministic bytes.
import { canonicalize } from "@irisrun/core";
import type { Json } from "@irisrun/core";
import { createHash } from "node:crypto";

export interface ToolContract {
  name: string; // model-visible; build-time collision check (ToolRegistry)
  description: string; // model-visible
  inputSchema: Json; // model-visible (JSON Schema as Json)
  transport: "in-process" | "subprocess" | "mcp" | "grpc";
  location: string; // "inproc://id" | "subprocess://cmd" | "mcp://cmd" | "grpc://host:port/svc/method"
  retrySafe: boolean; // idempotency posture metadata (ADR-0003); descriptive — the
  // harness config is authoritative for the EFFECT's posture (spec §3.5)
}

/**
 * sha256(canonicalize({ name, description, inputSchema })) — the model-perceived
 * surface only. transport/location/retrySafe are deliberately excluded so the
 * same logical tool keeps one identity across localities (ADR-0004). M3 computes
 * + exposes the digest; session-pinning enforcement is M4.
 */
export function contractDigest(contract: ToolContract): string {
  const surface: Json = {
    name: contract.name,
    description: contract.description,
    inputSchema: contract.inputSchema,
  };
  return createHash("sha256").update(canonicalize(surface)).digest("hex");
}

export interface ToolRegistry {
  register(contract: ToolContract): void; // throws on duplicate name
  get(name: string): ToolContract | undefined;
  has(name: string): boolean;
  names(): string[];
}

/**
 * A name-keyed registry of tool contracts. `register` rejects a duplicate name
 * loudly (build-time collision check, Spec 05 A1) — two tools sharing a
 * model-visible name is an authoring error, never silently overwritten.
 */
export function makeToolRegistry(initial: ToolContract[] = []): ToolRegistry {
  const byName = new Map<string, ToolContract>();
  const register = (contract: ToolContract): void => {
    if (byName.has(contract.name)) {
      throw new Error(
        `ToolRegistry: duplicate tool name "${contract.name}" — model-visible names must be unique`,
      );
    }
    byName.set(contract.name, contract);
  };
  for (const contract of initial) register(contract);
  return {
    register,
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
  };
}
