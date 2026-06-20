// Image build (spec §3.5): resolve + pin → embed content by hash → compute the
// content-addressed, deterministic imageDigest = sha256(canonicalize(canonical
// image)). The canonical image EXCLUDES the self-referential imageDigest field;
// content values are base64 STRINGS (canonicalize rejects Buffer/Uint8Array) and
// content keys are normalized (forward-slash, relative) for cross-platform
// determinism. Host-side (node:crypto + @irisrun/core canonicalize).
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, type Json } from "@irisrun/core";
import {
  contentPaths,
  contractRefs,
  type AgentfileModel,
  type CapabilityProfile,
} from "./agentfile.ts";
import {
  resolveLockTools,
  validateCapabilities,
  type Lock,
  type LockTool,
} from "./lock.ts";
import type { RegistryResolver } from "./resolver.ts";
import { bundleDigest, type BundleResolver } from "./bundle.ts";

export interface AgentImage {
  agentfile: AgentfileModel;
  lock: Lock; // includes imageDigest
  content: Record<string, string>; // normalized path → base64 bytes
}

export interface BuildOptions {
  resolver: RegistryResolver;
  readFile: (path: string) => Promise<Uint8Array>; // resolves a model path → bytes
  // OPTIONAL (M6): when set AND harness.bundle is present, the bundle ref is
  // resolved to a BundleDefinition and pinned by its REAL bundleDigest. When
  // absent (every M4 path), the M4 sha256Hex(id) placeholder is kept byte-for-byte
  // — back-compat is load-bearing, so existing M4 image digests are unchanged.
  resolveBundle?: BundleResolver;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Normalize a content path to a canonical, platform-independent key: forward
// slashes, no leading "./". So two builds on different OSes key the same file
// identically (canonicalize sorts keys lexicographically).
export function normalizeContentKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// The image MINUS its self-referential imageDigest — the bytes the digest is
// computed over (and recomputed by verify). Used by both build and verify.
export function canonicalImageOf(image: AgentImage): Json {
  const { imageDigest: _omit, ...lockSansDigest } = image.lock;
  return {
    agentfile: image.agentfile as unknown as Json,
    lock: lockSansDigest as unknown as Json,
    content: image.content,
  };
}

export function computeImageDigest(image: AgentImage): string {
  return sha256Hex(canonicalize(canonicalImageOf(image)));
}

/**
 * Resolve + pin contracts, embed content by hash, validate capabilities, and emit
 * a content-addressed image. Deterministic: identical inputs → identical
 * `imageDigest`.
 */
export async function buildImage(
  model: AgentfileModel,
  opts: BuildOptions,
): Promise<AgentImage> {
  // 1. Resolve + pin every tool/connection contract.
  const tools = await resolveLockTools(contractRefs(model), opts.resolver);
  // 2. Validate the capability profile against the resolved tools (loud).
  validateCapabilities(model.requires, tools);
  // 3. Embed content by hash (base64 value + sha256 hash, normalized key).
  const content: Record<string, string> = {};
  const contentHashes: Record<string, string> = {};
  for (const path of contentPaths(model)) {
    const bytes = await opts.readFile(path);
    const key = normalizeContentKey(path);
    content[key] = toBase64(bytes);
    contentHashes[key] = sha256Hex(bytes);
  }
  // 4. Pin the harness (bundle + explicit tactics) deterministically.
  const tactics: Record<string, { id: string; digest: string }> = {};
  if (model.harness.bundle !== undefined) {
    const id = model.harness.bundle;
    if (opts.resolveBundle !== undefined) {
      // M6: resolve the bundle ref to a definition and pin its REAL content digest.
      // The id stays the STABLE Agentfile ref (re-resolved by verify, location floats).
      const def = await opts.resolveBundle.resolve(id);
      if (def === null) {
        throw new Error(`build: dangling bundle ref — "${id}" did not resolve to a bundle definition`);
      }
      tactics.bundle = { id, digest: bundleDigest(def) };
    } else {
      // Back-compat (every M4 path): keep the sha256Hex(id) placeholder unchanged.
      tactics.bundle = { id, digest: sha256Hex(id) };
    }
  }
  for (const [seam, id] of Object.entries(model.harness.tactics ?? {})) {
    tactics[seam] = { id, digest: sha256Hex(id) };
  }
  // 5. Assemble the lock (imageDigest filled below) and compute the digest over
  //    the imageDigest-less canonical image.
  const lock: Lock = {
    imageDigest: "",
    model: { id: model.model },
    content: contentHashes,
    tools,
    tactics,
    capabilities: model.requires,
  };
  const image: AgentImage = { agentfile: model, lock, content };
  image.lock.imageDigest = computeImageDigest(image);
  return image;
}

// --- inspect (spec §3.5) ------------------------------------------------------

export interface ImageInspection {
  name: string;
  model: string;
  imageDigest: string;
  tools: LockTool[];
  content: Record<string, string>; // path → sha256
  tactics: Record<string, { id: string; digest: string }>;
  capabilities: CapabilityProfile;
  // Declared env/secrets (initiative 20260620-agentfile-env-secrets) — surfaced so
  // `iris inspect` answers "what secrets does this image require?". NAMES only;
  // secret VALUES are never stored. Omitted when the image declares neither.
  secrets?: string[];
  environment?: Record<string, string>;
}

/** Human-readable resolved intent of an image (what `iris inspect` prints). */
export function inspectImage(image: AgentImage): ImageInspection {
  return {
    name: image.agentfile.name,
    model: image.agentfile.model,
    imageDigest: image.lock.imageDigest,
    tools: image.lock.tools,
    content: image.lock.content,
    tactics: image.lock.tactics,
    capabilities: image.lock.capabilities,
    ...(image.agentfile.secrets !== undefined ? { secrets: image.agentfile.secrets } : {}),
    ...(image.agentfile.environment !== undefined ? { environment: image.agentfile.environment } : {}),
  };
}

// --- OCI image layout (local, files-only — spec §3.5) -------------------------
// Real registry push/pull (+ cosign) is the manual smoke; this is the install-free
// path. Shape: `oci-layout` + `index.json` + `blobs/sha256/<hex>`.

const IRIS_IMAGE_MEDIA_TYPE = "application/vnd.iris.agent.image+json";

export async function writeOciLayout(dir: string, image: AgentImage): Promise<void> {
  const blob = canonicalize(image as unknown as Json); // canonical bytes → stable blob
  const manifestDigest = sha256Hex(blob);
  await mkdir(join(dir, "blobs", "sha256"), { recursive: true });
  await writeFile(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(dir, "blobs", "sha256", manifestDigest), blob);
  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: IRIS_IMAGE_MEDIA_TYPE,
        digest: `sha256:${manifestDigest}`,
        size: Buffer.byteLength(blob),
        annotations: { "org.opencontainers.image.ref.name": image.lock.imageDigest },
      },
    ],
  };
  await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2));
}

// Note: the manifest blob's own digest (over the full image, incl. imageDigest) is
// NOT the imageDigest (computed over the imageDigest-LESS canonical image). Both
// are internally consistent; the ref.name annotation carries the imageDigest.
export async function readOciLayout(dir: string, ref?: string): Promise<AgentImage> {
  const index = JSON.parse(await fsReadFile(join(dir, "index.json"), "utf8")) as {
    manifests?: { digest?: string; annotations?: Record<string, string> }[];
  };
  const manifests = index.manifests ?? [];
  // Select by ref.name annotation when a ref is given; else the sole manifest.
  const manifest =
    ref !== undefined
      ? manifests.find((m) => m.annotations?.["org.opencontainers.image.ref.name"] === ref)
      : manifests[0];
  if (!manifest?.digest) {
    throw new Error(
      `readOciLayout: ${ref !== undefined ? `no manifest matching ref "${ref}"` : "no manifest"} in ${join(dir, "index.json")}`,
    );
  }
  const digest = manifest.digest.replace(/^sha256:/, "");
  const blob = await fsReadFile(join(dir, "blobs", "sha256", digest), "utf8");
  return JSON.parse(blob) as AgentImage;
}
