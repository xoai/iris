// @irisrun/bundle-coding — public surface (host-side; composes from @irisrun/core's
// exported tactic primitives only — @irisrun/core is the ONLY dependency, and this
// is NOT a host/transport package).
export const PACKAGE = "@irisrun/bundle-coding";

export {
  codingBundle,
  codingGate,
  codingDecideNext,
  BUNDLE_ID,
} from "./coding.ts";
export type { CodingBundleOptions } from "./coding.ts";
