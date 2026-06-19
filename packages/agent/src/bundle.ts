// Bundle resolution + digest (spec §4.2, ADR-0004) — the M6 strengthening of the
// M4 tactic pin. A tactic BUNDLE (e.g. `@iris/bundle-coding`) is distributed like
// a tool contract: an Agentfile `harness.bundle` ref (e.g. "iris/coding@^1")
// resolves — via an injected BundleResolver, mirroring the M4 RegistryResolver —
// to a concrete BundleDefinition, and the image pins `bundleDigest(def)` (a real
// content digest over the BEHAVIOR SURFACE) instead of the M4 sha256Hex(id)
// placeholder. The digest is STABLE across a floating `location` (re-resolve by
// stable ref, not by location — [[lrn-resolve-by-stable-ref-not-floating-location]])
// yet detects any change to the behavior surface (id/version/seams/...).
// Host-side (node:crypto + @iris/core canonicalize).
import { createHash } from "node:crypto";
import { canonicalize, type Json } from "@iris/core";

// The resolvable bundle surface. `id`/`version`/`seams` (and any further behavior
// fields) form the model-perceived BEHAVIOR SURFACE the digest covers. `location`
// is the CURRENT deploy/realization and FLOATS independently (ADR-0004) — it is
// EXCLUDED from the digest so floating an implementation does not break a pin.
export interface BundleDefinition {
  id: string;
  version: string;
  seams: string[];
  // The current realization (registry coordinate / blob ref). Floats per ADR-0004;
  // NOT part of the digest surface.
  location?: string;
  // Any further behavior-surface fields a bundle author records are digested too
  // (the canonicalized surface is the open-ended behavior contract).
  [k: string]: Json | undefined;
}

// A bundle resolver: resolve a stable Agentfile ref (e.g. "iris/coding@^1") to a
// concrete BundleDefinition, or null if unresolvable (the caller turns null into a
// loud dangling-ref error). Mirrors RegistryResolver for tools.
export interface BundleResolver {
  resolve(ref: string): Promise<BundleDefinition | null>;
}

// The behavior surface the digest is computed over: the full definition MINUS the
// floating `location` (and any undefined fields, which canonicalize rejects). Two
// definitions that differ only in `location` produce the SAME surface → the SAME
// digest (the ADR-0004 float-impl property); any behavior-surface change differs.
function behaviorSurface(def: BundleDefinition): Json {
  const surface: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(def)) {
    if (k === "location") continue; // floats — excluded from the digest
    if (v === undefined) continue; // canonicalize rejects undefined
    surface[k] = v as Json;
  }
  return surface;
}

/** sha256 over the canonical behavior surface — stable across location float. */
export function bundleDigest(def: BundleDefinition): string {
  return createHash("sha256").update(canonicalize(behaviorSurface(def))).digest("hex");
}
