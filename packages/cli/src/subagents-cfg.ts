// Subagent discovery (roadmap P2-9) — scan an agent project's optional `subagents.json`
// for delegate-tool → child-image declarations, mirroring loadBundledTools (`tools/`).
// This is the seam that makes subagent DELEGATION reachable from the CLI: a tool NAME
// listed here is dispatched by the kernel as a `subagent` effect (a child agent run),
// and `image` names the child layout the host resolves. Host-side; node: builtins only.
//
// Format — a JSON array beside the agent project:
//   [{ "name": "delegate", "image": "./children/researcher" }]
// `name` is the delegate tool name the parent model calls; `image` is the child OCI
// layout dir (resolved relative to the subagents.json file, or absolute). A missing
// file yields an EMPTY config (zero-value-off — agents without subagents stay valid).
import { readFile } from "node:fs/promises";

export interface SubagentEntry {
  name: string; // the delegate tool name (routed as a `subagent` effect)
  image: string; // the child agent's OCI layout dir
}

export interface SubagentsConfig {
  entries: SubagentEntry[];
  names: string[]; // entries.map(e => e.name) — passed to harnessProgram as subagentTools
}

const EMPTY: SubagentsConfig = { entries: [], names: [] };

export async function loadSubagents(file: string): Promise<SubagentsConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], names: [] };
    throw e;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`subagents config "${file}": invalid JSON — ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`subagents config "${file}": must be a JSON array of { name, image } entries`);
  }

  const entries: SubagentEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`subagents config "${file}": entry ${i} must be an object { name, image }`);
    }
    const o = e as { name?: unknown; image?: unknown };
    if (typeof o.name !== "string" || o.name === "") {
      throw new Error(`subagents config "${file}": entry ${i} needs a non-empty string "name"`);
    }
    if (typeof o.image !== "string" || o.image === "") {
      throw new Error(`subagents config "${file}": entry ${i} ("${o.name}") needs a non-empty string "image"`);
    }
    if (seen.has(o.name)) {
      throw new Error(`subagents config "${file}": duplicate subagent name "${o.name}" (delegate tool names must be unique)`);
    }
    seen.add(o.name);
    entries.push({ name: o.name, image: o.image });
  }

  if (entries.length === 0) return EMPTY;
  return { entries, names: entries.map((e) => e.name) };
}
