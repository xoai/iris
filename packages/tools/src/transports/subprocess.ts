// Subprocess transport (spec §3.3): spawn a REAL child process; exchange ONE
// line-delimited JSON request `{id,name,input}` (stdin) for ONE response line
// `{id,ok,value|error}` (stdout). Every failure mode — non-zero exit, malformed
// line, spawn failure, AND a hung child (bounded by a timeout) — maps to a clean
// `{ok:false}` (spec §7: no hang, no silent success). Host-side (node:child_process).
import { spawn } from "node:child_process";
import type { Json } from "@irisrun/core";
import type { Transport, ToolResult } from "../invoker.ts";
import { locationHandle, messageOf, toolFailure } from "../invoker.ts";

// A logical location ("subprocess://<id>") resolves host-side to a concrete
// spawn spec — the contract stays portable; the host decides the real command.
export interface SubprocessSpec {
  command: string;
  args?: string[];
}

export interface SubprocessOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

// Monotonic wire-id for the line protocol's request `id`. Host-side ephemeral
// (NOT journaled — the journaled identity is the ToolCall), so a module counter
// is fine; it disambiguates requests if the protocol is ever multiplexed (M5).
let requestSeq = 0;

export function makeSubprocessTransport(
  specs: Record<string, SubprocessSpec>,
  options: SubprocessOptions = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    invoke(contract, input) {
      const id = locationHandle(contract.location, "subprocess");
      const spec = specs[id];
      if (!spec) {
        return Promise.resolve(
          toolFailure(`subprocess tool not registered: "${id}"`, "unknown_tool"),
        );
      }
      return exchange(
        spec,
        { id: `req-${requestSeq++}`, name: contract.name, input },
        timeoutMs,
      );
    },
  };
}

interface ToolRequest {
  id: string;
  name: string;
  input: Json;
}

function exchange(
  spec: SubprocessSpec,
  request: ToolRequest,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Kill on the way out so a slow/hung child never lingers. Killing an
      // already-exited child throws; ignore it (the result is already decided).
      try {
        child.kill("SIGKILL");
      } catch {
        // child already gone — nothing to clean up.
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(toolFailure(`tool timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);

    child.on("error", (e) =>
      finish(toolFailure(`failed to spawn tool: ${messageOf(e)}`, "spawn_failed")),
    );
    // Writing to a dead child's stdin emits EPIPE on the stream; swallow it —
    // the exit/error handlers already produce the result.
    child.stdin.on("error", () => {});

    child.stdout.on("data", (d) => {
      stdout += d;
      const nl = stdout.indexOf("\n");
      if (nl >= 0) finish(parseResponse(stdout.slice(0, nl)));
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("exit", (code) => {
      if (settled) return;
      // Exited before a newline-terminated line. Accept a final line without a
      // trailing newline; otherwise report the non-response with the exit code.
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        finish(parseResponse(trimmed));
        return;
      }
      finish(
        toolFailure(
          `tool exited with code ${code} before responding${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
          "no_response",
        ),
      );
    });

    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (e) {
      finish(toolFailure(`failed to send request: ${messageOf(e)}`, "spawn_failed"));
    }
  });
}

function parseResponse(line: string): ToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return toolFailure(
      "tool returned a malformed (non-JSON) response line",
      "malformed_response",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return toolFailure("tool response was not a JSON object", "malformed_response");
  }
  const r = parsed as {
    ok?: unknown;
    value?: Json;
    error?: { message?: string; code?: string };
  };
  if (r.ok === true) {
    return { ok: true, value: (r.value ?? null) as Json };
  }
  if (r.ok === false) {
    const message = r.error?.message ?? "tool reported an error";
    return toolFailure(message, r.error?.code);
  }
  return toolFailure(
    'tool response missing a boolean "ok" field',
    "malformed_response",
  );
}
