// Registry resolver seam. The builder resolves each Agentfile tool/
// connection ref (which may carry a version range `@^2`) to a concrete
// ToolContract. Install-free: makeLocalResolver over an in-memory map; the real
// external registry is a manual smoke. Host-side.
import type { ToolContract } from "@irisrun/tools";

export interface RegistryResolver {
  // Resolve a ref (with optional `@range`) to a concrete contract, or null if
  // unresolvable (the builder turns null into a loud dangling-ref error).
  resolve(ref: string): Promise<ToolContract | null>;
}

/** Strip a trailing `@<range>` from a ref, e.g. `mcp://r/x@^2` → `mcp://r/x`. */
export function refBase(ref: string): string {
  const at = ref.lastIndexOf("@");
  const scheme = ref.indexOf("://");
  return scheme >= 0 && at > scheme + 2 ? ref.slice(0, at) : ref;
}

/**
 * A resolver over an in-memory `refBase → ToolContract` map (install-free). Both
 * `mcp://r/x@^2` and `mcp://r/x@^3` resolve via the shared base `mcp://r/x`,
 * modelling "pin the contract, float the implementation".
 */
export function makeLocalResolver(
  map: Record<string, ToolContract>,
): RegistryResolver {
  return {
    resolve: (ref) => Promise.resolve(map[refBase(ref)] ?? map[ref] ?? null),
  };
}

/**
 * Compose two resolvers: try `a` first, fall back to `b` (first non-null wins).
 * Lets the builder resolve refs from several sources — e.g. bundled subprocess
 * tools AND OpenAPI-generated http tools — through one `RegistryResolver`.
 */
export function composeResolvers(
  a: RegistryResolver,
  b: RegistryResolver,
): RegistryResolver {
  return {
    async resolve(ref) {
      return (await a.resolve(ref)) ?? (await b.resolve(ref));
    },
  };
}
