// @iris/bundle-coding — public surface (host-side; composes from @iris/core's
// exported tactic primitives only — @iris/core is the ONLY dependency, and this
// is NOT a host/transport package).
export const PACKAGE = "@iris/bundle-coding";

export {
  codingBundle,
  codingGate,
  codingDecideNext,
  BUNDLE_ID,
} from "./coding.ts";
export type { CodingBundleOptions } from "./coding.ts";
