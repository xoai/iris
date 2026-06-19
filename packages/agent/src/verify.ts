// Integrity verification (spec §3.6, ADR-0006 §4) — throws LOUDLY on any failure
// (no silent corruption, [[lrn-no-silent-policy-widening]]). Checks, in order:
// (1) every embedded content hash matches its bytes; (2) every tool contractDigest
// is still resolvable + unchanged; (3) the recomputed imageDigest equals the
// stored one (recompute strips the self-referential field, exactly as build does).
// Host-side.
import { contractDigest } from "@iris/tools";
import { sha256Hex, computeImageDigest, type AgentImage } from "./image.ts";
import type { RegistryResolver } from "./resolver.ts";
import { bundleDigest, type BundleResolver } from "./bundle.ts";

export interface VerifyOptions {
  resolver: RegistryResolver;
  // OPTIONAL (M6): when set, verify re-resolves Lock.tactics.bundle by its STABLE
  // id/ref, recomputes bundleDigest, and throws on mismatch. When absent, verify
  // behaves EXACTLY as M4 (it never touches the bundle) — back-compat.
  resolveBundle?: BundleResolver;
}

export async function verifyImage(
  image: AgentImage,
  opts: VerifyOptions,
): Promise<void> {
  // 1. content hashes match the embedded bytes
  for (const [path, hash] of Object.entries(image.lock.content)) {
    const b64 = image.content[path];
    if (b64 === undefined) {
      throw new Error(`verify: content "${path}" is recorded in the lock but missing from the image`);
    }
    const actual = sha256Hex(Buffer.from(b64, "base64"));
    if (actual !== hash) {
      throw new Error(`verify: content hash mismatch for "${path}" — lock ${hash}, actual ${actual}`);
    }
  }
  // 2. every tool contract is still resolvable (BY ITS STABLE ref — not location,
  //    which floats per ADR-0004) and its digest unchanged
  for (const tool of image.lock.tools) {
    const contract = await opts.resolver.resolve(tool.ref);
    if (contract === null) {
      throw new Error(
        `verify: dangling tool — "${tool.name}" (${tool.ref}) is no longer resolvable`,
      );
    }
    const digest = contractDigest(contract);
    if (digest !== tool.contractDigest) {
      throw new Error(
        `verify: contractDigest changed for "${tool.name}" — lock ${tool.contractDigest}, resolved ${digest}`,
      );
    }
  }
  // 3. recomputed imageDigest equals the stored one (computeImageDigest strips the
  //    self-referential imageDigest field, exactly as buildImage does)
  const recomputed = computeImageDigest(image);
  if (recomputed !== image.lock.imageDigest) {
    throw new Error(
      `verify: imageDigest mismatch — stored ${image.lock.imageDigest}, recomputed ${recomputed}`,
    );
  }
  // 4. (M6, NET-NEW) re-resolve the pinned tactic bundle by its STABLE id/ref (NOT
  //    a floating location, ADR-0004), recompute bundleDigest, and assert it equals
  //    the pinned digest. This catches a CONTENT-tampered bundle whose pinned lock
  //    digest is left unchanged — invisible to the imageDigest check above. Skipped
  //    entirely when no resolveBundle is injected (M4 back-compat).
  if (opts.resolveBundle !== undefined) {
    const pinned = image.lock.tactics.bundle;
    if (pinned !== undefined) {
      const def = await opts.resolveBundle.resolve(pinned.id);
      if (def === null) {
        throw new Error(
          `verify: dangling tactic bundle — "${pinned.id}" is no longer resolvable`,
        );
      }
      const digest = bundleDigest(def);
      if (digest !== pinned.digest) {
        throw new Error(
          `verify: bundle digest changed for "${pinned.id}" — lock ${pinned.digest}, resolved ${digest}`,
        );
      }
    }
  }
}
