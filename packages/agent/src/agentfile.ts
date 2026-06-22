// Agentfile model + JSON parser + validation. The Agentfile
// is a RECIPE: it references content (embedded by hash) and contracts (pinned by
// digest) and contains NO executable behavior. Host-side; zero deps.
import type { Json } from "@irisrun/core";

// The capability profile. NEW @irisrun/agent type (the framework doc
// defines the shape; no core type exists). `tool_locality:"in-process"` is a
// legal PROFILE value (it mirrors @irisrun/tools ToolLocality) — distinct from a
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
  // Env/secrets (initiative 20260620-agentfile-env-secrets). BOTH optional and
  // OMITTED-when-absent so existing image digests are byte-identical. `secrets` =
  // NAMES of required runtime secrets — VALUES are supplied at run time and never
  // enter the manifest/image/journal. `environment` = literal NON-secret config
  // defaults (values are part of the recipe → digest-affecting when present).
  secrets?: string[];
  environment?: Record<string, string>;
}

// A contract ref must use one of these schemes; anything else (incl. an inline
// `code`/`script`/`source` field) is inlined behavior and is rejected.
const CONTRACT_SCHEMES = ["mcp", "grpc", "subprocess", "http"] as const;
const INLINE_BEHAVIOR_FIELDS = ["code", "script", "source"] as const;

// `requires` (the capability profile) is strict-when-present so the runtime
// validator agrees with the published JSON schema (schema.ts): a present
// `tool_locality` must be one of these, and a present boolean cap must be a
// boolean. (Initiative 20260620-agentfile-schema — these were untyped before.)
const TOOL_LOCALITIES = ["in-process", "local", "remote"] as const;
const BOOLEAN_CAPS = ["long_running", "local_subprocess", "filesystem", "websockets"] as const;

// A POSIX-style environment-variable NAME: a letter/underscore then letters/
// digits/underscores. Used for both `secrets` entries and `environment` keys here
// AND re-exported (index.ts) so the CLI env resolver enforces the SAME shape —
// authoring-time and runtime agree on what a valid name is.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isEnvName(s: string): boolean {
  return ENV_NAME_RE.test(s);
}

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
 * (no behavior in the manifest). Throws loudly; never coerces.
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
  // Default ONLY when ABSENT (undefined). An explicit JSON `null` is wrong-typed
  // — the schema types harness/requires as `object`, so a present null must be
  // rejected, not coerced to {} (which `?? {}` would do). sandbox needs no guard:
  // it is required, so null/absent already throws via asObject below.
  const harness = asObject(o.harness === undefined ? {} : o.harness, "harness");
  const requires = asObject(o.requires === undefined ? {} : o.requires, "requires");
  validateCapabilityProfile(requires);
  const sandbox = asObject(o.sandbox, "sandbox");

  // Build optional sub-objects WITHOUT undefined keys — canonicalize (used for
  // the imageDigest) rejects undefined values, and omission keeps the YAML/JSON
  // models deep-equal. A present-but-wrong-typed `bundle`/`workspace` now throws
  // (was silently dropped) so the runtime agrees with the JSON schema; a
  // well-typed value behaves exactly as before, so existing digests are unchanged.
  const harnessOut: AgentfileModel["harness"] = {};
  if (harness.bundle !== undefined) {
    if (typeof harness.bundle !== "string") throw new Error("Agentfile: harness.bundle must be a string");
    harnessOut.bundle = harness.bundle;
  }
  if (harness.tactics !== undefined) {
    harnessOut.tactics = asObject(harness.tactics, "harness.tactics") as Record<string, string>;
  }
  const sandboxOut: AgentfileModel["sandbox"] = {
    backend: requireString(sandbox, "sandbox.backend", "backend"),
    network: requireString(sandbox, "sandbox.network", "network"),
  };
  if (sandbox.workspace !== undefined) {
    if (typeof sandbox.workspace !== "string") throw new Error("Agentfile: sandbox.workspace must be a string");
    sandboxOut.workspace = sandbox.workspace;
  }

  // Env/secrets — OPTIONAL; validated strictly, OMITTED when absent (canonicalize
  // throws on undefined AND omission keeps existing digests byte-identical).
  const secretsOut = validateSecrets(o.secrets);
  const environmentOut = validateEnvironment(o.environment);
  if (secretsOut !== undefined && environmentOut !== undefined) {
    for (const name of secretsOut) {
      if (Object.prototype.hasOwnProperty.call(environmentOut, name)) {
        throw new Error(
          `Agentfile: "${name}" is declared as both a secret and an environment literal — a name must be one or the other`,
        );
      }
    }
  }

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
    requires: requires as CapabilityProfile,
    sandbox: sandboxOut,
    ...(secretsOut !== undefined ? { secrets: secretsOut } : {}),
    ...(environmentOut !== undefined ? { environment: environmentOut } : {}),
  };
}

// Validate the OPTIONAL `secrets` (NAMES of required runtime secrets). Returns the
// validated array, or undefined when absent (omitted from the model → digest-stable).
// Order is author-significant and digest-affecting — NOT sorted.
function validateSecrets(v: Json | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new Error('Agentfile: "secrets" must be an array of environment-variable names');
  }
  const seen = new Set<string>();
  for (const entry of v) {
    if (typeof entry !== "string" || !isEnvName(entry)) {
      throw new Error(
        `Agentfile: secrets[] entry ${JSON.stringify(entry)} is not a valid env-var name (a letter/underscore then letters/digits/underscores)`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`Agentfile: duplicate secret name "${entry}"`);
    }
    seen.add(entry);
  }
  return v as string[];
}

// Validate the OPTIONAL `environment` (literal NON-secret config). Scalar values
// (string/number/boolean) are coerced to strings HERE — env vars are inherently
// strings, so JSON `"3"`, YAML `3`, and YAML `"3"` all produce the SAME model and
// therefore the SAME imageDigest. null/object/array values are rejected loudly.
// Returns the coerced map, or undefined when absent.
function validateEnvironment(v: Json | undefined): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  const o = asObject(v, "environment");
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(o)) {
    if (!isEnvName(key)) {
      throw new Error(
        `Agentfile: environment key ${JSON.stringify(key)} is not a valid env-var name (a letter/underscore then letters/digits/underscores)`,
      );
    }
    if (typeof val === "string") {
      out[key] = val;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = String(val);
    } else {
      const kind = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
      throw new Error(`Agentfile: environment.${key} must be a string (got ${kind})`);
    }
  }
  return out;
}

// Strict-when-present validation of the capability profile (`requires`), so the
// runtime agrees with the published JSON schema. Unknown keys are still ignored
// (retained in the model) — only the KNOWN fields are type-checked when present.
function validateCapabilityProfile(o: { [k: string]: Json }): void {
  for (const cap of BOOLEAN_CAPS) {
    if (cap in o && typeof o[cap] !== "boolean") {
      throw new Error(`Agentfile: requires.${cap} must be a boolean`);
    }
  }
  const tl = o.tool_locality;
  if (tl !== undefined && !(TOOL_LOCALITIES as readonly string[]).includes(tl as string)) {
    throw new Error(
      `Agentfile: requires.tool_locality must be one of ${TOOL_LOCALITIES.join("/")} (got ${JSON.stringify(tl)})`,
    );
  }
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

// Validate a tools/connections array, rejecting inlined behavior.
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
          `Agentfile: ${key}[${i}] carries inline behavior ("${field}") — tools are contracts referenced by digest, not inlined code`,
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
