// Agentfile model + JSON parser + validation (spec §3.2, ADR-0005). The Agentfile
// is a RECIPE: it references content (embedded by hash) and contracts (pinned by
// digest) and contains NO executable behavior. Host-side; zero deps.
import type { Json } from "@iris/core";

// The capability profile (ADR-0008). NEW @iris/agent type (the framework doc
// defines the shape; no core type exists). `tool_locality:"in-process"` is a
// legal PROFILE value (it mirrors @iris/tools ToolLocality) — distinct from a
// resolved tool-contract transport, which may NOT be in-process in an Agentfile.
export interface CapabilityProfile {
  long_running?: boolean;
  local_subprocess?: boolean;
  filesystem?: boolean;
  websockets?: boolean;
  tool_locality?: "in-process" | "local" | "remote";
}

export interface ToolRef {
  ref: string; // mcp:// | grpc:// | subprocess://  (version range allowed: @^2)
}

export interface AgentfileModel {
  apiVersion: "iris/v1";
  kind: "Agent";
  name: string;
  model: string;
  instructions: string; // CONTENT path → embedded by hash
  skills: string[]; // CONTENT paths
  tools: ToolRef[]; // CONTRACT refs → pinned by digest
  connections: ToolRef[]; // CONTRACT refs
  harness: { bundle?: string; tactics?: Record<string, string> };
  requires: CapabilityProfile;
  sandbox: { backend: string; workspace?: string; network: string };
}

// A contract ref must use one of these schemes; anything else (incl. an inline
// `code`/`script`/`source` field) is inlined behavior and is rejected (ADR-0005).
const CONTRACT_SCHEMES = ["mcp", "grpc", "subprocess"] as const;
const INLINE_BEHAVIOR_FIELDS = ["code", "script", "source"] as const;

/** Parse Agentfile JSON text into a validated model (throws loudly on bad JSON or shape). */
export function parseAgentfileJson(text: string): AgentfileModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Agentfile: invalid JSON — ${(e as Error).message}`);
  }
  return validateAgentfile(raw);
}

/**
 * Validate a raw parsed object into an AgentfileModel. Guards every boundary
 * (shape, required fields) and enforces the content-vs-contract split: a tool /
 * connection entry is REJECTED if it carries an inline-behavior field
 * (code/script/source) or a ref whose scheme is not mcp/grpc/subprocess
 * (ADR-0005 — no behavior in the manifest). Throws loudly; never coerces.
 */
export function validateAgentfile(raw: unknown): AgentfileModel {
  const o = asObject(raw, "Agentfile");
  if (o.apiVersion !== "iris/v1") {
    throw new Error(`Agentfile: apiVersion must be "iris/v1" (got ${JSON.stringify(o.apiVersion)})`);
  }
  if (o.kind !== "Agent") {
    throw new Error(`Agentfile: kind must be "Agent" (got ${JSON.stringify(o.kind)})`);
  }
  const name = requireString(o, "name");
  const model = requireString(o, "model");
  const instructions = requireString(o, "instructions");
  const skills = requireStringArray(o, "skills");
  const tools = requireRefArray(o, "tools");
  const connections = requireRefArray(o, "connections");
  const harness = asObject(o.harness ?? {}, "harness");
  const requires = asObject(o.requires ?? {}, "requires") as CapabilityProfile;
  const sandbox = asObject(o.sandbox, "sandbox");

  // Build optional sub-objects WITHOUT undefined keys — canonicalize (used for
  // the imageDigest) rejects undefined values, and omission keeps the YAML/JSON
  // models deep-equal.
  const harnessOut: AgentfileModel["harness"] = {};
  if (typeof harness.bundle === "string") harnessOut.bundle = harness.bundle;
  if (harness.tactics !== undefined) {
    harnessOut.tactics = asObject(harness.tactics, "harness.tactics") as Record<string, string>;
  }
  const sandboxOut: AgentfileModel["sandbox"] = {
    backend: requireString(sandbox, "sandbox.backend", "backend"),
    network: requireString(sandbox, "sandbox.network", "network"),
  };
  if (typeof sandbox.workspace === "string") sandboxOut.workspace = sandbox.workspace;

  return {
    apiVersion: "iris/v1",
    kind: "Agent",
    name,
    model,
    instructions,
    skills,
    tools,
    connections,
    harness: harnessOut,
    requires,
    sandbox: sandboxOut,
  };
}

function asObject(v: unknown, what: string): { [k: string]: Json } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`Agentfile: ${what} must be an object`);
  }
  return v as { [k: string]: Json };
}

function requireString(o: { [k: string]: Json }, label: string, key = label): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Agentfile: required field "${label}" must be a non-empty string`);
  }
  return v;
}

function requireStringArray(o: { [k: string]: Json }, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`Agentfile: "${key}" must be an array of strings`);
  }
  return v as string[];
}

// Validate a tools/connections array, rejecting inlined behavior (ADR-0005).
function requireRefArray(o: { [k: string]: Json }, key: string): ToolRef[] {
  const v = o[key];
  if (!Array.isArray(v)) {
    throw new Error(`Agentfile: "${key}" must be an array`);
  }
  return v.map((entry, i) => {
    const e = asObject(entry, `${key}[${i}]`);
    for (const field of INLINE_BEHAVIOR_FIELDS) {
      if (field in e) {
        throw new Error(
          `Agentfile: ${key}[${i}] carries inline behavior ("${field}") — tools are contracts referenced by digest, not inlined code (ADR-0005)`,
        );
      }
    }
    const ref = e.ref;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new Error(`Agentfile: ${key}[${i}].ref must be a non-empty string`);
    }
    const scheme = refScheme(ref);
    if (!(CONTRACT_SCHEMES as readonly string[]).includes(scheme)) {
      throw new Error(
        `Agentfile: ${key}[${i}] ref scheme "${scheme}" is not a contract scheme (must be one of ${CONTRACT_SCHEMES.join("/")}) — got "${ref}"`,
      );
    }
    return { ref };
  });
}

/** Content paths embedded by hash: instructions, skills, then sandbox.workspace (if any). */
export function contentPaths(model: AgentfileModel): string[] {
  const paths = [model.instructions, ...model.skills];
  if (model.sandbox.workspace !== undefined) paths.push(model.sandbox.workspace);
  return paths;
}

/** Contract refs pinned by digest: tools then connections. */
export function contractRefs(model: AgentfileModel): ToolRef[] {
  return [...model.tools, ...model.connections];
}

/** The scheme of a contract ref, e.g. "mcp" for "mcp://registry/x@^2". */
export function refScheme(ref: string): string {
  const i = ref.indexOf("://");
  return i > 0 ? ref.slice(0, i) : "";
}
