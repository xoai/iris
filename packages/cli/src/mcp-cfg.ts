// MCP-server discovery — scan an agent project's optional `mcp.json` for the runtime
// servers that back its `mcp://` tools. Mirrors loadSubagents (`subagents.json`): a
// tool's LOCATION HANDLE (the `mcp://` ref minus scheme, e.g. `registry/mem0@^1` — shown
// by `iris inspect`) maps to the command that runs its MCP server. A missing file yields
// an EMPTY map (zero-value-off — agents without MCP tools stay byte-identical). Host-side.
//
// Format — a JSON array beside the agent project:
//   [{ "name": "registry/mem0", "command": "npx", "args": ["-y", "mem0-mcp"] }]
// `name` is the tool's mcp:// location handle; `command`/`args` spawn its stdio server.
import { readFile } from "node:fs/promises";
import type { McpServerSpec } from "@irisrun/tools";

export async function loadMcpServers(file: string): Promise<Record<string, McpServerSpec>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`mcp config "${file}": invalid JSON — ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`mcp config "${file}": must be a JSON array of { name, command, args? } entries`);
  }

  const servers: Record<string, McpServerSpec> = {};
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`mcp config "${file}": entry ${i} must be an object { name, command, args? }`);
    }
    const o = e as { name?: unknown; command?: unknown; args?: unknown };
    if (typeof o.name !== "string" || o.name === "") {
      throw new Error(
        `mcp config "${file}": entry ${i} needs a non-empty string "name" (the tool's mcp:// location handle)`,
      );
    }
    if (typeof o.command !== "string" || o.command === "") {
      throw new Error(`mcp config "${file}": entry ${i} ("${o.name}") needs a non-empty string "command"`);
    }
    if (o.args !== undefined && (!Array.isArray(o.args) || o.args.some((a) => typeof a !== "string"))) {
      throw new Error(`mcp config "${file}": entry ${i} ("${o.name}") "args" must be an array of strings`);
    }
    if (servers[o.name]) {
      throw new Error(`mcp config "${file}": duplicate server name "${o.name}"`);
    }
    servers[o.name] = { command: o.command, ...(o.args !== undefined ? { args: o.args as string[] } : {}) };
  }
  return servers;
}
