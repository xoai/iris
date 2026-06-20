// Bundled-tool discovery: scan an agent project's `tools/` directory for
// `*.tool.json` descriptors and produce (a) a RegistryResolver so `iris build`
// resolves the scaffolded `subprocess://<id>` refs, and (b) the subprocess spawn
// specs so `iris run/chat/serve` can actually INVOKE the tool. This is the seam
// that turns the scaffold's batteries-included tool into something the agent can
// call with no external server. Host-side; node: builtins + workspace pkgs only.
//
// An Agentfile cannot author an in-process tool (CONTRACT_SCHEMES =
// mcp|grpc|subprocess), so a bundled, server-free tool is a SUBPROCESS tool: a
// small script shipped beside the Agentfile, ref scheme = transport.
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { makeLocalResolver } from "@irisrun/agent";
import type { RegistryResolver } from "@irisrun/agent";
import type { ToolContract, SubprocessSpec } from "@irisrun/tools";
import type { Json } from "@irisrun/core";

const SUBPROCESS_PREFIX = "subprocess://";

export interface BundledTools {
  resolver: RegistryResolver; // ref → ToolContract (empty map when no tools/)
  subprocessSpecs: Record<string, SubprocessSpec>; // locationHandle → spawn spec
  contracts: ToolContract[]; // resolved contracts (for introspection/tests)
  // Names of retrySafe (reversible/read-only) bundled tools. The harness gates
  // irreversible/unknown tools by default (approve-irreversible → "ask"); these
  // are passed as `safeTools` so a read-only starter tool auto-allows rather than
  // parking the first run on an approval — exactly what the gate's allowlist is for.
  safeToolNames: string[];
}

interface ToolDescriptor {
  ref: string;
  name: string;
  description: string;
  inputSchema: Json;
  retrySafe: boolean;
  exec?: string; // sugar: a node script file within the tools dir
  command?: string; // escape hatch: explicit command…
  args?: string[]; //          …+ verbatim args (for non-node tools)
}

/**
 * Discover the bundled tools under `toolsDir`. A missing directory yields an
 * EMPTY result (tool-less agents stay valid). Every `*.tool.json` is validated
 * loudly — malformed JSON, a missing/empty required field, a non-`subprocess`
 * ref, a duplicate ref or tool name, or an `exec` that escapes the tools dir all
 * throw with a message naming the offending file. No silent skip, no overwrite.
 */
export async function loadBundledTools(toolsDir: string): Promise<BundledTools> {
  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { resolver: makeLocalResolver({}), subprocessSpecs: {}, contracts: [], safeToolNames: [] };
    }
    throw e;
  }

  const files = entries.filter((f) => f.endsWith(".tool.json")).sort();
  const byRef: Record<string, ToolContract> = {};
  const subprocessSpecs: Record<string, SubprocessSpec> = {};
  const contracts: ToolContract[] = [];
  const seenNames = new Set<string>();

  for (const file of files) {
    const desc = parseDescriptor(await readFile(join(toolsDir, file), "utf8"), file);

    if (byRef[desc.ref] !== undefined) {
      throw new Error(`bundled tool "${file}": duplicate ref "${desc.ref}" (already declared by another descriptor)`);
    }
    if (seenNames.has(desc.name)) {
      throw new Error(`bundled tool "${file}": duplicate tool name "${desc.name}" (model-visible names must be unique)`);
    }

    const handle = desc.ref.slice(SUBPROCESS_PREFIX.length);
    const contract: ToolContract = {
      name: desc.name,
      description: desc.description,
      inputSchema: desc.inputSchema,
      transport: "subprocess",
      location: desc.ref, // location = ref → locationHandle(ref) === handle
      retrySafe: desc.retrySafe,
    };

    byRef[desc.ref] = contract;
    subprocessSpecs[handle] = specOf(desc, toolsDir, file);
    contracts.push(contract);
    seenNames.add(desc.name);
  }

  const safeToolNames = contracts.filter((c) => c.retrySafe).map((c) => c.name);
  return { resolver: makeLocalResolver(byRef), subprocessSpecs, contracts, safeToolNames };
}

// Parse + validate one descriptor (every boundary guarded; throws name the file).
function parseDescriptor(text: string, file: string): ToolDescriptor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`bundled tool "${file}": invalid JSON — ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`bundled tool "${file}": descriptor must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;

  const ref = reqString(o, "ref", file);
  if (!ref.startsWith(SUBPROCESS_PREFIX) || ref.length <= SUBPROCESS_PREFIX.length) {
    throw new Error(`bundled tool "${file}": ref "${ref}" must be a non-empty subprocess:// ref (this build wires only the subprocess transport)`);
  }
  const name = reqString(o, "name", file);
  const description = reqString(o, "description", file);
  if (o.inputSchema === null || typeof o.inputSchema !== "object" || Array.isArray(o.inputSchema)) {
    throw new Error(`bundled tool "${file}": "inputSchema" must be a JSON object`);
  }
  if (typeof o.retrySafe !== "boolean") {
    throw new Error(`bundled tool "${file}": "retrySafe" must be a boolean`);
  }

  const desc: ToolDescriptor = {
    ref,
    name,
    description,
    inputSchema: o.inputSchema as Json,
    retrySafe: o.retrySafe,
  };
  if (o.exec !== undefined) {
    if (typeof o.exec !== "string" || o.exec.length === 0) {
      throw new Error(`bundled tool "${file}": "exec" must be a non-empty string`);
    }
    desc.exec = o.exec;
  }
  if (o.command !== undefined) {
    if (typeof o.command !== "string" || o.command.length === 0) {
      throw new Error(`bundled tool "${file}": "command" must be a non-empty string`);
    }
    desc.command = o.command;
  }
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === "string")) {
      throw new Error(`bundled tool "${file}": "args" must be an array of strings`);
    }
    desc.args = o.args as string[];
  }
  if (desc.exec === undefined && desc.command === undefined) {
    throw new Error(`bundled tool "${file}": must specify "exec" (a node script) or "command"`);
  }
  return desc;
}

// Resolve a descriptor to a concrete spawn spec. `exec` is the common sugar (a
// node script run with THIS node binary — no PATH dependency); it must be a
// relative path inside the tools dir (no absolute, no `..` escape).
function specOf(desc: ToolDescriptor, toolsDir: string, file: string): SubprocessSpec {
  if (desc.exec !== undefined) {
    if (isAbsolute(desc.exec) || desc.exec.split(/[\\/]/).includes("..")) {
      throw new Error(`bundled tool "${file}": "exec" must be a relative path inside the tools dir (no absolute path, no "..")`);
    }
    return { command: process.execPath, args: [join(toolsDir, desc.exec)] };
  }
  // Escape hatch: explicit command + verbatim args (the author is responsible).
  return { command: desc.command as string, args: desc.args ?? [] };
}

function reqString(o: Record<string, unknown>, key: string, file: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`bundled tool "${file}": required field "${key}" must be a non-empty string`);
  }
  return v;
}
