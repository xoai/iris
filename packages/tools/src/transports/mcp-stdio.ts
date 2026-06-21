// MCP-stdio transport: a minimal MCP client over stdio. Spawn the
// server child; speak newline-delimited JSON-RPC 2.0 — `initialize`, then the
// `notifications/initialized` notification, then `tools/call {name, arguments}`.
// Map the result (`isError` / JSON-RPC `error`) to a ToolResult. Host-side
// (node:child_process); the real external-server path is the manual smoke.
import { spawn } from "node:child_process";
import type { Json } from "@irisrun/core";
import type { Transport, ToolResult } from "../invoker.ts";
import { locationHandle, messageOf, toolFailure } from "../invoker.ts";

export interface McpServerSpec {
  command: string;
  args?: string[];
}

export interface McpStdioOptions {
  timeoutMs?: number;
  protocolVersion?: string;
  // When set, the server child is spawned with EXACTLY this environment
  // (least-privilege — the CLI passes the image's scoped tool env so a declared
  // secret like MEM0_API_KEY reaches the server). Absent → inherit process.env.
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROTOCOL = "2024-11-05";

export function makeMcpStdioTransport(
  servers: Record<string, McpServerSpec>,
  options: McpStdioOptions = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL;
  const env = options.env;
  return {
    invoke(contract, input) {
      const id = locationHandle(contract.location, "mcp");
      const spec = servers[id];
      if (!spec) {
        return Promise.resolve(
          toolFailure(`mcp server not registered: "${id}"`, "unknown_tool"),
        );
      }
      return callOverStdio(spec, contract.name, input, timeoutMs, protocolVersion, env);
    },
  };
}

interface JsonRpcResponse {
  id?: number;
  result?: Json;
  error?: { code?: number; message?: string };
}

function callOverStdio(
  spec: McpServerSpec,
  toolName: string,
  input: Json,
  timeoutMs: number,
  protocolVersion: string,
  env: Record<string, string> | undefined,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, (msg: JsonRpcResponse) => void>();

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(toolFailure(`mcp tool timed out after ${timeoutMs}ms`, "timeout")),
      timeoutMs,
    );

    child.on("error", (e) =>
      finish(
        toolFailure(`failed to spawn mcp server: ${messageOf(e)}`, "spawn_failed"),
      ),
    );
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("exit", (code) => {
      if (settled) return;
      finish(
        toolFailure(
          `mcp server exited with code ${code} before responding${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
          "no_response",
        ),
      );
    });

    child.stdout.on("data", (d) => {
      stdout += d;
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          finish(
            toolFailure(
              "mcp server sent a malformed (non-JSON) line",
              "malformed_response",
            ),
          );
          return;
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const handler = pending.get(msg.id)!;
          pending.delete(msg.id);
          handler(msg);
        }
        // notifications / unknown ids are ignored
      }
    });

    const request = (method: string, params: Json): Promise<JsonRpcResponse> => {
      const id = nextId++;
      return new Promise<JsonRpcResponse>((res) => {
        pending.set(id, res);
        try {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        } catch (e) {
          finish(
            toolFailure(`failed to send ${method}: ${messageOf(e)}`, "spawn_failed"),
          );
        }
      });
    };

    const notify = (method: string, params: Json): void => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      } catch {
        // a dead child's stdin — the exit/timeout handler decides the result
      }
    };

    void (async () => {
      const init = await request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "iris", version: "0.0.0" },
      });
      if (settled) return;
      if (init.error) {
        finish(
          toolFailure(
            `mcp initialize failed: ${init.error.message ?? "error"}`,
            "mcp_error",
          ),
        );
        return;
      }
      notify("notifications/initialized", {});
      const call = await request("tools/call", { name: toolName, arguments: input });
      if (settled) return;
      finish(mapCallResponse(call));
    })();
  });
}

function mapCallResponse(resp: JsonRpcResponse): ToolResult {
  if (resp.error) {
    return toolFailure(
      `mcp error: ${resp.error.message ?? "error"}`,
      resp.error.code !== undefined ? String(resp.error.code) : "mcp_error",
    );
  }
  const result = resp.result;
  if (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as { isError?: Json }).isError === true
  ) {
    return toolFailure(textOf(result) || "mcp tool reported isError", "tool_error");
  }
  return { ok: true, value: (result ?? null) as Json };
}

// Concatenate the text content blocks of an MCP result (for an error message).
function textOf(result: Json): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return "";
  }
  const content = (result as { content?: Json }).content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as { type?: Json }).type === "text" &&
      typeof (block as { text?: Json }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.join("\n");
}
