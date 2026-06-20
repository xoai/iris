// The capability-diff DEPLOY gate. Where
// `checkHostCapabilities` (adapter.ts) is the build/tool-level boolean refusal,
// `assertDeployable` is the DEPLOY-time check of an image's CapabilityProfile
// against a HostAdapter — a different axis (spec §2.4). It diffs TWO dimensions:
//
//   • the boolean caps (long_running/local_subprocess/filesystem/websockets) —
//     the SAME rule checkHostCapabilities uses: requires[k]===true but the host
//     does NOT provide it (host[k]!==true) ⇒ a gap, with the precise per-cap
//     message "<cap> (required true, host has <X>)".
//   • tool_locality — ranked by HOST DEMAND remote=0 < local=1 < in-process=2.
//     On the host side the field is OVERLOADED to mean the host's CEILING (the
//     most-demanding locality it can physically realize: edge=remote). An image
//     that demands a locality MORE than the host ceiling ⇒ a gap.
//
// The local-tools-on-edge gap (local_subprocess required, OR tool_locality over
// the ceiling) emits the LITERAL refusal template, interpolating
// host.name — with name "Cloudflare" it is byte-identical to the example.
// `assertDeployable` throws an Error joining every gap's message: refuse LOUDLY,
// never silently degrade (graceful auto-degrade is explicitly out of scope).
import type { CapabilityProfile } from "@irisrun/agent";
import type { HostAdapter } from "./adapter.ts";

// The boolean capability keys (tool_locality is the STRING dimension, handled
// separately by rank). Mirrors adapter.ts's BOOLEAN_CAPS, kept local so the two
// gates stay independent.
const BOOLEAN_CAPS = [
  "long_running",
  "local_subprocess",
  "filesystem",
  "websockets",
] as const;

// tool_locality demand rank: remote is the LEAST host-demanding (any host can
// reach a network endpoint; the only option on edge), in-process the MOST (the
// tool runs inside the core process — only a trusted same-language host). The
// host side reads its tool_locality as the CEILING; an image demanding a
// higher-ranked locality than the ceiling cannot be satisfied.
const LOCALITY_RANK: Record<NonNullable<CapabilityProfile["tool_locality"]>, number> = {
  remote: 0,
  local: 1,
  "in-process": 2,
};

function localityRank(v: CapabilityProfile["tool_locality"] | undefined): number {
  // An absent demand defaults to `remote` (the least-demanding, edge-safe floor).
  return LOCALITY_RANK[v ?? "remote"];
}

export interface CapabilityGap {
  capability: keyof CapabilityProfile;
  required: unknown;
  hostProvides: unknown;
  message: string; // precise, host-refusal-style
}

/** The literal host-capability refusal, interpolating the host
 *  label. With `name === "Cloudflare"` the result is byte-identical to the example. */
function localToolsRefusal(hostName: string): string {
  return `this agent requires local_subprocess tools; the ${hostName} target supports remote MCP tools only. Set tool_locality: remote or choose a VPS/serverless target.`;
}

/**
 * Diff an image's required CapabilityProfile against a host's capabilities,
 * returning the structured gaps (empty ⇒ deployable). Booleans reuse the
 * checkHostCapabilities rule; tool_locality compares the image's DEMAND to the
 * host's CEILING by the fixed rank remote<local<in-process. The local-tools-on-edge
 * gap (local_subprocess required, OR tool_locality over ceiling) carries the
 * literal refusal message; every other boolean gap carries the precise per-cap
 * message. Never silently widens: undefined/false on the host = NOT satisfied.
 */
export function diffCapabilities(requires: CapabilityProfile, host: HostAdapter): CapabilityGap[] {
  const caps = host.capabilities;
  const gaps: CapabilityGap[] = [];

  for (const k of BOOLEAN_CAPS) {
    if (k === "local_subprocess") continue; // handled with the locality dimension below
    if (requires[k] === true && caps[k] !== true) {
      gaps.push({
        capability: k,
        required: true,
        hostProvides: caps[k],
        message: `${k} (required true, host has ${JSON.stringify(caps[k])})`,
      });
    }
  }

  // The local-tools-on-edge dimension: local_subprocess demanded, OR the
  // requested tool_locality is more host-demanding than the host's ceiling. Both
  // surface as the literal refusal.
  const ceiling = caps.tool_locality;
  const wantsLocalSubprocess = requires.local_subprocess === true && caps.local_subprocess !== true;
  const localityOverCeiling = localityRank(requires.tool_locality) > localityRank(ceiling);

  if (wantsLocalSubprocess) {
    gaps.push({
      capability: "local_subprocess",
      required: true,
      hostProvides: caps.local_subprocess,
      message: localToolsRefusal(host.name),
    });
  }
  if (localityOverCeiling) {
    gaps.push({
      capability: "tool_locality",
      required: requires.tool_locality,
      hostProvides: ceiling,
      message: localToolsRefusal(host.name),
    });
  }

  return gaps;
}

/**
 * The deploy gate: throw an Error joining every gap's precise message if the
 * image cannot run on the host; return silently if it can. Refuse LOUDLY — never
 * degrade or silently widen the host's policy.
 */
export function assertDeployable(requires: CapabilityProfile, host: HostAdapter): void {
  const gaps = diffCapabilities(requires, host);
  if (gaps.length > 0) {
    // De-duplicate identical messages before joining: an image demanding BOTH
    // local_subprocess AND an over-ceiling tool_locality is ONE root cause (local
    // tools on a remote-only host) and both gaps carry the same literal
    // refusal — the user-facing message must render that sentence ONCE, not twice.
    // (diffCapabilities still returns both structured gaps for programmatic inspection.)
    const messages = [...new Set(gaps.map((g) => g.message))];
    throw new Error(messages.join("; "));
  }
}
