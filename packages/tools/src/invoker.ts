// The uniform ToolInvoker: one invoke(...) interface
// over N transports, dispatched by contract.transport. Host-side; transports
// MAY use node: builtins. A missing transport fails loudly (no silent success).
import type { Json } from "@irisrun/core";
import type { ToolContract } from "./contract.ts";

export type ToolResult =
  | { ok: true; value: Json }
  | { ok: false; error: { message: string; code?: string } };

// A single physical realization. The adapter and every concrete transport share
// this signature so the performer/locality resolver treat them uniformly.
export interface Transport {
  invoke(
    contract: ToolContract,
    input: Json,
    idempotencyKey?: string,
  ): Promise<ToolResult>;
}

export type ToolInvoker = Transport;

export type TransportTable = Partial<Record<ToolContract["transport"], Transport>>;

/**
 * The uniform adapter: dispatch on `contract.transport` to a configured
 * Transport. A transport that is not configured yields a precise `{ok:false}`
 * (code `no_transport`) — never a silent no-op.
 */
export function makeToolInvoker(transports: TransportTable): ToolInvoker {
  return {
    invoke(contract, input, idempotencyKey) {
      const transport = transports[contract.transport];
      if (!transport) {
        return Promise.resolve<ToolResult>({
          ok: false,
          error: {
            message: `no transport configured for "${contract.transport}" (tool "${contract.name}")`,
            code: "no_transport",
          },
        });
      }
      return transport.invoke(contract, input, idempotencyKey);
    },
  };
}

/** A `{ok:false}` ToolResult, omitting `code` when absent (clean Json). */
export function toolFailure(message: string, code?: string): ToolResult {
  return {
    ok: false,
    error: code !== undefined ? { message, code } : { message },
  };
}

/** Best-effort message from an unknown thrown value. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Strip a `<scheme>://` prefix from a location, yielding the host handle. */
export function locationHandle(location: string, scheme: string): string {
  const prefix = `${scheme}://`;
  return location.startsWith(prefix) ? location.slice(prefix.length) : location;
}

// --- tool_locality resolution ------------------------------------------------
// Locality selects the PHYSICAL realization without changing the model-perceived
// surface, so the same logical tool keeps one contractDigest across localities.

export type ToolLocality = "in-process" | "local" | "remote";

// The model-perceived surface + idempotency posture, before a physical binding.
export interface LogicalTool {
  name: string;
  description: string;
  inputSchema: Json;
  retrySafe: boolean;
}

export interface LocalityOption {
  transport: ToolContract["transport"];
  location: string;
}

export type LocalityOptions = Partial<Record<ToolLocality, LocalityOption>>;

// Which transports are valid for each locality: in-process is the
// trusted same-language case; local is a subprocess; remote is a network call.
const ALLOWED_TRANSPORTS: Record<ToolLocality, ToolContract["transport"][]> = {
  "in-process": ["in-process"],
  local: ["subprocess"],
  remote: ["mcp", "grpc", "http"],
};

/**
 * Resolve a logical tool at a locality into a concrete ToolContract. The
 * model-perceived surface (name/description/inputSchema) is carried through
 * unchanged so `contractDigest` is identical across localities. A locality with
 * no configured transport — or one bound to the wrong transport kind — is a
 * configuration error and is refused LOUDLY (the tool-level capability check).
 */
export function resolveLocality(
  tool: LogicalTool,
  locality: ToolLocality,
  options: LocalityOptions,
): ToolContract {
  const option = options[locality];
  if (!option) {
    const configured = Object.keys(options).join(", ") || "none";
    throw new Error(
      `tool "${tool.name}": no transport configured for locality "${locality}" (configured: ${configured})`,
    );
  }
  const allowed = ALLOWED_TRANSPORTS[locality];
  if (!allowed.includes(option.transport)) {
    throw new Error(
      `tool "${tool.name}": locality "${locality}" must use one of [${allowed.join(", ")}], got "${option.transport}"`,
    );
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    transport: option.transport,
    location: option.location,
    retrySafe: tool.retrySafe,
  };
}
