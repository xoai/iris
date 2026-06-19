// @iris/agent — public surface (host-side; zero external deps).
export const PACKAGE = "@iris/agent";

export {
  parseAgentfileJson,
  validateAgentfile,
  contentPaths,
  contractRefs,
  refScheme,
} from "./agentfile.ts";
export type {
  AgentfileModel,
  CapabilityProfile,
  ToolRef,
} from "./agentfile.ts";

export { parseAgentfileYaml, parseYamlValue } from "./yaml.ts";

export { makeLocalResolver, refBase } from "./resolver.ts";
export type { RegistryResolver } from "./resolver.ts";

export { resolveLockTools, validateCapabilities } from "./lock.ts";
export type { Lock, LockTool } from "./lock.ts";

export {
  buildImage,
  sha256Hex,
  normalizeContentKey,
  canonicalImageOf,
  computeImageDigest,
  inspectImage,
  writeOciLayout,
  readOciLayout,
} from "./image.ts";
export type { AgentImage, BuildOptions, ImageInspection } from "./image.ts";

export { verifyImage } from "./verify.ts";
export type { VerifyOptions } from "./verify.ts";

export { bundleDigest } from "./bundle.ts";
export type { BundleDefinition, BundleResolver } from "./bundle.ts";

export { latestRecord, governingDigest, migrateDefinition } from "./pin.ts";
export type { MigrateOptions } from "./pin.ts";
