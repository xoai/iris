// The PUBLISHED Agentfile schema (JSON Schema draft 2020-12) + a zero-dep
// checker that interprets it. The schema is a SECOND surface over the same
// contract `validateAgentfile` (agentfile.ts) enforces — the two are pinned to
// agree by a shared conformance corpus (tests/agentfile-schema.test.ts), so a
// published schema can never silently drift from the runtime validator (the
// provider-adapter "one shared conformance suite" idea applied to validation).
//
// Why a hand-rolled checker instead of an off-the-shelf JSON-Schema lib: the
// repo is zero-runtime-deps. `checkAgainstSchema` interprets ONLY the keyword
// subset this schema uses (documented in `validateNode`), so the schema stays
// executable in-repo and by any consumer that vendors this file. Host-side.

// The schema is intentionally LENIENT on unknown keys (`additionalProperties:
// true` at every level) to match the runtime validator, which ignores unknown
// keys (forward-compat: a future Agentfile field must not fail an old schema).
// The closed constraints are exactly what `validateAgentfile` enforces.
export const AGENTFILE_SCHEMA: { [k: string]: unknown } = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://iris.run/schema/agentfile/v1.json",
  title: "Iris Agentfile (iris/v1, kind Agent)",
  description:
    "An Iris Agentfile: a declarative RECIPE that references content (embedded by hash) and tool/connection contracts (pinned by digest). It carries NO executable behavior.",
  type: "object",
  required: [
    "apiVersion",
    "kind",
    "name",
    "model",
    "instructions",
    "skills",
    "tools",
    "connections",
    "sandbox",
  ],
  properties: {
    $schema: {
      type: "string",
      description:
        "Optional editor/CI schema URI. Ignored by Iris — dropped from the parsed model, so it never affects the image digest.",
    },
    apiVersion: { const: "iris/v1", description: 'Schema version. Must be "iris/v1".' },
    kind: { const: "Agent", description: 'Resource kind. Must be "Agent".' },
    name: { type: "string", minLength: 1, description: "Agent name (non-empty)." },
    model: {
      type: "string",
      minLength: 1,
      description: 'Provider-prefixed model id, e.g. "anthropic/claude-x".',
    },
    instructions: {
      type: "string",
      minLength: 1,
      description: "Path to the instructions file — CONTENT, embedded by hash.",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description: "Paths to skill files — CONTENT, embedded by hash.",
    },
    tools: {
      type: "array",
      items: { $ref: "#/$defs/contractRef" },
      description: "Tool CONTRACT refs (mcp/grpc/subprocess), pinned by digest.",
    },
    connections: {
      type: "array",
      items: { $ref: "#/$defs/contractRef" },
      description: "Connection CONTRACT refs (mcp/grpc/subprocess), pinned by digest.",
    },
    harness: { $ref: "#/$defs/harness" },
    requires: { $ref: "#/$defs/capabilityProfile" },
    sandbox: { $ref: "#/$defs/sandbox" },
    // Env/secrets (initiative 20260620-agentfile-env-secrets). `secrets` = NAMES
    // of required runtime secrets (VALUES are supplied at run time, never in the
    // manifest). `environment` = literal NON-secret config defaults.
    // AGREEMENT-CORPUS FOOTGUN: the zero-dep checker can express only what is
    // below — secrets is an array of pattern-valid strings, and environment is an
    // object. It CANNOT express secrets uniqueness, secrets/environment overlap,
    // environment KEY patterns, or environment VALUE typing. Those are runtime-only
    // (validateAgentfile) and must NOT be added to the T3 agreement corpus — the
    // schema accepts them, so a corpus entry would make the two surfaces disagree.
    secrets: {
      type: "array",
      items: { type: "string", minLength: 1, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      description:
        "Names of required runtime secrets — values are supplied at run time, never stored in the manifest/image.",
    },
    environment: {
      type: "object",
      description:
        "Literal NON-secret config defaults (string values). Object-ness is the shared constraint with the runtime; value coercion/typing is runtime-only.",
    },
  },
  additionalProperties: true,
  $defs: {
    contractRef: {
      type: "object",
      required: ["ref"],
      properties: {
        ref: {
          type: "string",
          minLength: 1,
          pattern: "^(mcp|grpc|subprocess)://",
          description: "Contract ref. Scheme must be mcp, grpc, or subprocess.",
        },
        // A tool/connection is a contract referenced by digest, never
        // inlined code. A present code/script/source field validates against the
        // boolean `false` subschema → rejected.
        code: false,
        script: false,
        source: false,
      },
      additionalProperties: true,
    },
    capabilityProfile: {
      type: "object",
      properties: {
        long_running: { type: "boolean" },
        local_subprocess: { type: "boolean" },
        filesystem: { type: "boolean" },
        websockets: { type: "boolean" },
        tool_locality: {
          enum: ["in-process", "local", "remote"],
          description: "Where tools run. One of in-process, local, remote.",
        },
      },
      additionalProperties: true,
    },
    sandbox: {
      type: "object",
      required: ["backend", "network"],
      properties: {
        backend: { type: "string", minLength: 1 },
        network: { type: "string", minLength: 1 },
        workspace: {
          type: "string",
          description: "Optional workspace path — CONTENT, embedded by hash.",
        },
      },
      additionalProperties: true,
    },
    harness: {
      type: "object",
      properties: {
        bundle: { type: "string" },
        tactics: { type: "object" },
      },
      additionalProperties: true,
    },
  },
};

/** Canonical pretty-printed JSON text of the schema (e.g. `iris schema > file`). */
export function agentfileSchemaJson(): string {
  return JSON.stringify(AGENTFILE_SCHEMA, null, 2);
}

/**
 * Validate a value against the Agentfile schema. Returns a list of
 * "path: message" errors (empty ⇒ valid). NEVER throws on a malformed instance
 * (only a malformed *schema*, which is this file's own code, could throw).
 */
export function checkAgainstSchema(value: unknown): string[] {
  const errors: string[] = [];
  validateNode(value, AGENTFILE_SCHEMA, "", errors);
  return errors;
}

type SchemaNode = boolean | { [k: string]: unknown };

// The supported JSON-Schema subset: boolean subschemas (true/false), `$ref`
// (only "#/$defs/<name>"), `type` (string|boolean|number|integer|array|object),
// `const`, `enum`, `minLength`, `pattern` (compiled with `new RegExp(pattern)` —
// DEFAULT flags only, so `^` anchors to string-start, matching refScheme), plus
// `required`, `properties`, and `items`. Unknown keys are NOT constrained (the
// schema is `additionalProperties: true` everywhere by design); any other schema
// keyword is ignored.
function validateNode(value: unknown, schema: SchemaNode, path: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path || "(root)"}: not allowed`);
    return;
  }

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref);
    validateNode(value, resolved, path, errors);
    return;
  }

  // `const` / `enum` apply regardless of type.
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path || "(root)"}: must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path || "(root)"}: must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (typeof schema.type === "string" && !typeMatches(value, schema.type)) {
    errors.push(`${path || "(root)"}: must be of type ${schema.type}`);
    return; // stop — deeper keywords assume the type holds
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path || "(root)"}: must be a non-empty string`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path || "(root)"}: must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => validateNode(item, schema.items as SchemaNode, `${path}[${i}]`, errors));
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) errors.push(`${joinPath(path, key)}: required (missing)`);
      }
    }
    // Validate only PRESENT, KNOWN properties. The Agentfile schema is
    // `additionalProperties: true` at every level by design (forward-compat,
    // matching the runtime's lenient-on-unknown-keys behavior), so unknown keys
    // are intentionally not constrained.
    const props = isPlainObject(schema.properties) ? schema.properties : undefined;
    if (props) {
      for (const key of Object.keys(value)) {
        if (key in props) validateNode(value[key], props[key] as SchemaNode, joinPath(path, key), errors);
      }
    }
  }
}

function resolveRef(ref: string): SchemaNode {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`Agentfile schema: unsupported $ref "${ref}"`);
  const defs = AGENTFILE_SCHEMA.$defs as { [k: string]: SchemaNode } | undefined;
  const node = defs?.[ref.slice(prefix.length)];
  if (node === undefined) throw new Error(`Agentfile schema: unknown $ref "${ref}"`);
  return node;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value as number);
    default:
      return true; // unknown type keyword — do not constrain
  }
}

function isPlainObject(v: unknown): v is { [k: string]: unknown } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
