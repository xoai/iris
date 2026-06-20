// @irisrun/provider-compat — the conformance-verified provider compatibility matrix
// (roadmap v0.2 §9). A registry of OpenAI- and Anthropic-protocol endpoints, each
// classified replay-safe vs known-divergent and pinned by a CI conformance test, so
// "OpenAI-compatible" becomes a tested, replay-safe guarantee — not a loose claim.
// Pure data + a deterministic render; zero dependencies.
export const PACKAGE = "@irisrun/provider-compat";

export type { Protocol, ReplaySafety, CompatEntry } from "./matrix.ts";
export { COMPAT_MATRIX, entriesByProtocol, findEntry } from "./matrix.ts";
export { renderCompatMatrix } from "./render.ts";
