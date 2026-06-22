// OpenAPI → tools (initiative 20260622-openapi-transport). Reads an `openapi.json`
// config beside the layout: a JSON array of { name, spec, baseUrl, authSecretEnv? }.
// Each referenced OpenAPI 3.0 spec is parsed into N `http://<name>/<operationId>`
// tool contracts (+ an HttpSpec per operation). Zero-value-off: a missing config
// yields empty tools (byte-identical to no http tools). Host-side.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Json } from "@irisrun/core";
import type { ToolContract, HttpSpec } from "@irisrun/tools";
import { makeLocalResolver } from "@irisrun/agent";
import type { RegistryResolver } from "@irisrun/agent";

export interface OpenApiTools {
  resolver: RegistryResolver;
  httpSpecs: Record<string, HttpSpec>;
  contracts: ToolContract[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export async function loadOpenApiTools(file: string): Promise<OpenApiTools> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { resolver: makeLocalResolver({}), httpSpecs: {}, contracts: [] };
    }
    throw e;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch (e) {
    throw new Error(`openapi config "${file}": invalid JSON — ${(e as Error).message}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`openapi config "${file}": must be a JSON array of { name, spec, baseUrl } entries`);
  }

  const configDir = dirname(file);
  const byRef: Record<string, ToolContract> = {};
  const httpSpecs: Record<string, HttpSpec> = {};
  const contracts: ToolContract[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isObj(e) || typeof e.name !== "string" || e.name === "") {
      throw new Error(`openapi config "${file}": entry ${i} needs a non-empty string "name"`);
    }
    if (typeof e.spec !== "string" || e.spec === "") {
      throw new Error(`openapi config "${file}": entry ${i} ("${e.name}") needs a string "spec" path`);
    }
    if (typeof e.baseUrl !== "string" || e.baseUrl === "") {
      throw new Error(`openapi config "${file}": entry ${i} ("${e.name}") needs a string "baseUrl"`);
    }
    if (e.authSecretEnv !== undefined && typeof e.authSecretEnv !== "string") {
      throw new Error(`openapi config "${file}": entry ${i} ("${e.name}") "authSecretEnv" must be a string`);
    }
    const ns = e.name;
    const authSecretEnv = e.authSecretEnv;

    const specPath = isAbsolute(e.spec) ? e.spec : join(configDir, e.spec);
    let spec: unknown;
    try {
      spec = JSON.parse(await readFile(specPath, "utf8"));
    } catch (e2) {
      throw new Error(`openapi spec "${specPath}" (entry "${ns}") could not be read/parsed — ${(e2 as Error).message}`);
    }
    if (!isObj(spec) || typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
      throw new Error(`openapi spec "${specPath}": only OpenAPI 3.0 is supported`);
    }
    const components = isObj(spec.components) ? spec.components : {};
    const paths = isObj(spec.paths) ? spec.paths : {};

    for (const [path, pathItem] of Object.entries(paths)) {
      if (!isObj(pathItem)) continue;
      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!isObj(op)) continue;
        if (typeof op.operationId !== "string" || op.operationId === "") {
          throw new Error(`openapi spec "${specPath}": ${method.toUpperCase()} ${path} is missing a string operationId`);
        }
        const opId = op.operationId;
        if (seenNames.has(opId)) {
          throw new Error(`openapi: duplicate operationId "${opId}" — tool names must be unique`);
        }
        seenNames.add(opId);

        const { inputSchema, queryKeys } = deriveInputSchema(op, components, specPath);
        const ref = `http://${ns}/${opId}`;
        const contract: ToolContract = {
          name: opId,
          description:
            typeof op.summary === "string" ? op.summary : typeof op.description === "string" ? op.description : "",
          inputSchema,
          transport: "http",
          location: ref,
          retrySafe: method === "get" || method === "head",
        };
        byRef[ref] = contract;
        contracts.push(contract);
        httpSpecs[`${ns}/${opId}`] = {
          baseUrl: e.baseUrl,
          method: method.toUpperCase(),
          path,
          ...(queryKeys.length > 0 ? { query: queryKeys } : {}),
          ...(authSecretEnv !== undefined ? { authSecretEnv } : {}),
        };
      }
    }
  }
  return { resolver: makeLocalResolver(byRef), httpSpecs, contracts };
}

// Resolve local `#/components/schemas/*` $refs inline; a non-local/unknown ref is a
// loud reject. Bounded depth guards against a circular spec.
function resolveRef(value: unknown, components: Obj, specPath: string, depth = 0): unknown {
  if (depth > 40) throw new Error(`openapi spec "${specPath}": $ref nesting too deep (circular?)`);
  if (Array.isArray(value)) return value.map((v) => resolveRef(v, components, specPath, depth + 1));
  if (isObj(value)) {
    if (typeof value.$ref === "string") {
      const m = /^#\/components\/schemas\/(.+)$/.exec(value.$ref);
      if (!m) throw new Error(`openapi spec "${specPath}": unsupported $ref "${value.$ref}" (only #/components/schemas/* is supported)`);
      const schemas = isObj(components.schemas) ? components.schemas : {};
      const target = schemas[m[1]];
      if (target === undefined) throw new Error(`openapi spec "${specPath}": $ref "${value.$ref}" not found`);
      return resolveRef(target, components, specPath, depth + 1);
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRef(v, components, specPath, depth + 1);
    return out;
  }
  return value;
}

// Merge an operation's parameters[] (path/query; header/cookie deferred) and its
// application/json requestBody into ONE JSON Schema object. A body-property name that
// collides with a parameter nests the whole body under a `body` property.
function deriveInputSchema(op: Obj, components: Obj, specPath: string): { inputSchema: Json; queryKeys: string[] } {
  const properties: Obj = {};
  const required: string[] = [];
  const queryKeys: string[] = [];

  const params = Array.isArray(op.parameters) ? op.parameters : [];
  for (const raw of params) {
    const p = resolveRef(raw, components, specPath);
    if (!isObj(p) || typeof p.name !== "string") continue;
    if (p.in === "query") queryKeys.push(p.name);
    else if (p.in !== "path") continue; // header/cookie deferred
    properties[p.name] = p.schema ?? { type: "string" };
    if (p.required === true) required.push(p.name);
  }

  if (isObj(op.requestBody)) {
    const content = isObj(op.requestBody.content) ? op.requestBody.content : {};
    const media = isObj(content["application/json"]) ? (content["application/json"] as Obj) : undefined;
    if (media && media.schema !== undefined) {
      const resolved = resolveRef(media.schema, components, specPath);
      const bodyProps = isObj(resolved) && resolved.type === "object" && isObj(resolved.properties) ? resolved.properties : undefined;
      const collides = bodyProps ? Object.keys(bodyProps).some((k) => k in properties) : true;
      if (bodyProps && !collides) {
        for (const [k, v] of Object.entries(bodyProps)) properties[k] = v;
        if (isObj(resolved) && Array.isArray(resolved.required)) {
          for (const r of resolved.required) if (typeof r === "string") required.push(r);
        }
      } else {
        properties.body = resolved;
        if (op.requestBody.required === true) required.push("body");
      }
    }
  }

  const inputSchema: Obj = { type: "object", properties };
  if (required.length > 0) inputSchema.required = required;
  return { inputSchema: inputSchema as Json, queryKeys };
}
