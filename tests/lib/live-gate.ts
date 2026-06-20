// Gate for the env-gated LIVE conformance tier (roadmap v0.2 P2 #7). The live
// tier hits the real provider endpoints, so it runs ONLY when explicitly enabled
// AND the relevant API key is present — otherwise the tests SKIP cleanly (never
// fail) so the default suite stays green here and in CI without keys. The gate
// MUST be consulted BEFORE constructing a live performer (construction throws
// when no key and no fetchImpl), so callers pass `{ skip: gate.skip }` to
// node:test and only build the performer inside the test body when enabled.
export interface LiveGate {
  enabled: boolean;
  skip: string | false; // node:test `{ skip }` value: a reason string when off, false when on
  apiKey: string; // empty string when disabled — never read unless enabled
}

/**
 * @param envKey the provider's API-key env var, e.g. "ANTHROPIC_API_KEY".
 * Enabled iff IRIS_LIVE_CONFORMANCE is truthy AND envKey is set.
 */
export function liveGate(envKey: string): LiveGate {
  const flag = process.env.IRIS_LIVE_CONFORMANCE;
  const on = flag === "1" || flag === "true";
  const apiKey = process.env[envKey] ?? "";
  if (!on) {
    return { enabled: false, skip: "live conformance off — set IRIS_LIVE_CONFORMANCE=1 to enable", apiKey: "" };
  }
  if (!apiKey) {
    return { enabled: false, skip: `live conformance enabled but ${envKey} is not set`, apiKey: "" };
  }
  return { enabled: true, skip: false, apiKey };
}
