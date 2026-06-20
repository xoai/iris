// Canonical JSON serialization. Deterministic bytes are the basis
// for snapshot storage and the replay byte-equality assertion. Pure; uses only
// the Web-standard TextEncoder/TextDecoder globals (no Node-only API), so core
// stays edge/WASM-reachable.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/**
 * Deterministic JSON string: object keys sorted recursively, array order
 * preserved. Rejects values that have no canonical JSON form (undefined,
 * NaN/Infinity, BigInt, functions, symbols, and non-plain objects such as
 * Map/Set/class instances) — loudly, never with silent coercion.
 */
export function canonicalize(value: Json): string {
  return write(value, []);
}

function write(v: unknown, path: string[]): string {
  if (v === null) return "null";

  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new Error(`canonicalize: non-finite number at ${pathStr(path)}`);
    }
    return JSON.stringify(v);
  }
  if (t === "string") return JSON.stringify(v);

  if (Array.isArray(v)) {
    const items = v.map((item, i) => write(item, [...path, String(i)]));
    return `[${items.join(",")}]`;
  }

  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `canonicalize: non-plain object (${proto?.constructor?.name ?? "unknown"}) at ${pathStr(path)} — only plain JSON objects are allowed`,
      );
    }
    const obj = v as { [k: string]: unknown };
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) {
        throw new Error(
          `canonicalize: undefined value at ${pathStr([...path, k])} — use null or omit the key`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${write(val, [...path, k])}`);
    }
    return `{${parts.join(",")}}`;
  }

  // undefined, bigint, function, symbol
  throw new Error(
    `canonicalize: unsupported value of type "${t}" at ${pathStr(path)}`,
  );
}

function pathStr(path: string[]): string {
  return path.length ? `$.${path.join(".")}` : "$";
}

/** UTF-8 canonical bytes for a JSON value. */
export function encode(value: Json): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** Parse UTF-8 bytes back into a JSON value. */
export function decode(bytes: Uint8Array): Json {
  return JSON.parse(new TextDecoder().decode(bytes)) as Json;
}

/** True iff two JSON values have identical canonical form (byte-equality). */
export function canonicalEqual(a: Json, b: Json): boolean {
  return canonicalize(a) === canonicalize(b);
}
