// Test helper (NOT core): statically scans TypeScript source for import/require
// specifiers so the boundary rule (A1) can assert `core/` imports no host/transport/
// Node-only package. Lives under tests/, so using node:fs here is fine.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Recursively list `.ts` files under `dir`. */
export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Matches: `import ... from 'X'`, `export ... from 'X'`, bare `import 'X'`,
// dynamic `import('X')`, and `require('X')`. Captures the specifier in one of
// three groups.
const SPEC_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract every module specifier referenced by a source string. */
export function specifiersInSource(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

export interface Reference {
  file: string;
  specifier: string;
}

/** Every (file, specifier) pair under `dir`. */
export function specifiersInDir(dir: string): Reference[] {
  const refs: Reference[] = [];
  for (const file of listTsFiles(dir)) {
    const src = readFileSync(file, "utf8");
    for (const specifier of specifiersInSource(src)) {
      refs.push({ file, specifier });
    }
  }
  return refs;
}

// Host/transport package patterns that must never appear in core. Used to
// produce a precise failure message (the relative-only rule below is the
// primary check; this names *why* a non-relative import is bad).
const HOST_DENYLIST: ReadonlyArray<RegExp> = [
  /^@iris\/(store|host|channel|provider)/,
  /^better-sqlite3/,
  /^sqlite3$/,
  /^pg$/,
  /^mysql/,
  /^redis/,
  /^ioredis/,
  /^ws$/,
  /^express/,
  /^fastify/,
  /^@grpc\//,
  /^grpc$/,
  /^node-fetch/,
];

/**
 * Classify a specifier from `core/`. Returns a human-readable reason if the
 * import is forbidden, or null if it is allowed.
 *
 * The rule: core is pure and dependency-free, so it may import ONLY relative
 * specifiers. Anything non-relative is forbidden — that directly encodes
 * "core imports no host/transport package" and keeps core edge/WASM-reachable.
 */
export function classifyForbidden(specifier: string): string | null {
  if (specifier.startsWith(".")) return null; // relative — allowed
  if (specifier.startsWith("node:")) return "Node-only builtin";
  for (const re of HOST_DENYLIST) {
    if (re.test(specifier)) return "host/transport package";
  }
  return "non-relative import (core must be dependency-free)";
}
