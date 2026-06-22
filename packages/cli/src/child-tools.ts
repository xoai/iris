// A subagent CHILD's tool invoker. Mirrors the top-level `bundledToolWiring`
// transports — subprocess + mcp + http — so a delegated child can run the same tool
// kinds as its parent (configs live beside the child's own layout). Zero-value-off
// per transport (absent config → that transport simply isn't wired).
//
// Deferred non-goals (consistent with the subagent feature's existing limits):
//   - Child env-scoping: no transport-level env is threaded; a child's tools inherit
//     the host process.env (privilege-BROADENING, not a leak — see buildSubagents).
//     So a child `http://` tool that needs an auth secret is subject to that same
//     deferred non-goal.
//   - Child sandbox: `--sandbox` is NOT applied to children (a child defaults to the
//     `inmemory` backend, which buildSandboxExecutor refuses for real tools — auto-
//     applying it would break every `--sandbox` + subagent run). Its own design call.
import { dirname, join } from "node:path";
import { makeToolInvoker, makeSubprocessTransport, makeMcpStdioTransport, makeHttpTransport } from "@irisrun/tools";
import { loadBundledTools } from "./tools.ts";
import { loadMcpServers } from "./mcp-cfg.ts";
import { loadOpenApiTools } from "./openapi-cfg.ts";

export async function childToolWiring(
  childLayout: string,
): Promise<{ toolInvoker: ReturnType<typeof makeToolInvoker>; safeTools: string[] }> {
  const root = dirname(childLayout); // tools/mcp.json/openapi.json sit beside the layout
  const bundled = await loadBundledTools(join(root, "tools"));
  const mcpServers = await loadMcpServers(join(root, "mcp.json"));
  const openapi = await loadOpenApiTools(join(root, "openapi.json"));
  return {
    toolInvoker: makeToolInvoker({
      subprocess: makeSubprocessTransport(bundled.subprocessSpecs),
      ...(Object.keys(mcpServers).length > 0 ? { mcp: makeMcpStdioTransport(mcpServers) } : {}),
      ...(Object.keys(openapi.httpSpecs).length > 0 ? { http: makeHttpTransport(openapi.httpSpecs) } : {}),
    }),
    safeTools: bundled.safeToolNames,
  };
}
