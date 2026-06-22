// HTTP transport: one operation-tool = one HTTP call. The `http://<handle>` location
// resolves host-side to an HttpSpec; `input` fills `{path}` params + query + a JSON
// body; a named secret is injected ONLY on the Authorization header (never the URL).
// The response JSON body IS the tool value. Every failure → a clean `{ok:false}`
// (no hang: an AbortController bounds the request). Host-side; `fetch`/`AbortController`
// are Node globals — zero new deps.
import type { Json } from "@irisrun/core";
import type { Transport, ToolResult } from "../invoker.ts";
import { locationHandle, messageOf, toolFailure } from "../invoker.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// A logical `http://<handle>` resolves host-side to a concrete request shape. The
// contract stays portable; the host (the OpenAPI loader / config) decides the spec.
export interface HttpSpec {
  baseUrl: string; // e.g. "https://api.example.com/v1" (the deploy-time knob; floats)
  method: string; // "GET" | "POST" | ...
  path: string; // may contain "{param}" placeholders filled from input
  query?: string[]; // input keys sent as query params
  authSecretEnv?: string; // env var holding the auth value (NEVER placed in the URL)
  authHeader?: string; // default "authorization"
  authScheme?: "Bearer" | "raw"; // default "Bearer"
}

export interface HttpOptions {
  timeoutMs?: number;
  // Transport-level env (the image's scoped secrets/config) — the ONLY source of
  // auth values. Absent → a spec that names an auth secret fails loudly.
  env?: Record<string, string>;
}

function asObject(input: Json): Record<string, Json> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, Json>)
    : {};
}

export function makeHttpTransport(
  specs: Record<string, HttpSpec>,
  options: HttpOptions = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env;
  return {
    async invoke(contract, input) {
      const handle = locationHandle(contract.location, "http");
      const spec = specs[handle];
      if (!spec) {
        return toolFailure(`http tool not registered: "${handle}"`, "unknown_tool");
      }
      const args = asObject(input);

      // {path} params (consumed from input); the rest is available for query/body.
      const usedKeys = new Set<string>();
      const filledPath = spec.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        usedKeys.add(name);
        return encodeURIComponent(String(args[name] ?? ""));
      });

      let url: URL;
      try {
        url = new URL(filledPath, spec.baseUrl.endsWith("/") ? spec.baseUrl : `${spec.baseUrl}/`);
      } catch (e) {
        return toolFailure(`http: bad URL for "${handle}": ${messageOf(e)}`, "bad_url");
      }
      for (const key of spec.query ?? []) {
        usedKeys.add(key);
        if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
      }

      const headers: Record<string, string> = {};
      // Auth: a named secret → the Authorization header ONLY. A spec that names a
      // secret with no value fails loudly (no silent unauthenticated request).
      if (spec.authSecretEnv) {
        const value = env?.[spec.authSecretEnv];
        if (value === undefined || value === "") {
          return toolFailure(`http: auth secret "${spec.authSecretEnv}" not provided`, "missing_secret");
        }
        const header = (spec.authHeader ?? "authorization").toLowerCase();
        headers[header] = spec.authScheme === "raw" ? value : `Bearer ${value}`;
      }

      const method = spec.method.toUpperCase();
      let body: string | undefined;
      if (BODY_METHODS.has(method)) {
        const rest: Record<string, Json> = {};
        for (const [k, v] of Object.entries(args)) if (!usedKeys.has(k)) rest[k] = v;
        // Only attach a JSON body when there are leftover (non-path/query) fields —
        // a path/query-only call (incl. a bodyless DELETE) sends no body, so a server
        // that rejects an unexpected body isn't tripped.
        if (Object.keys(rest).length > 0) {
          body = JSON.stringify(rest);
          headers["content-type"] = "application/json";
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: controller.signal });
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        // The message carries no URL (which could embed query) — only a code.
        return toolFailure(
          aborted ? `http: request timed out after ${timeoutMs}ms` : `http: request failed`,
          aborted ? "timeout" : "request_failed",
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      if (!res.ok) {
        // Truncate the upstream body; never echo the request URL (it may carry query).
        const snippet = text.slice(0, 500);
        return toolFailure(
          `http: tool returned HTTP ${res.status}${snippet.trim() ? `: ${snippet}` : ""}`,
          `http_${res.status}`,
        );
      }
      if (text.trim() === "") return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(text) as Json };
      } catch {
        return toolFailure("http: tool returned a malformed (non-JSON) response body", "malformed_response");
      }
    },
  };
}
