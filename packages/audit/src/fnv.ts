// A tiny, pure FNV-1a (32-bit) hex hash. Used as a SHORT, deterministic fingerprint
// for cross-host state/journal comparison — NOT a security hash. Pure (no node:crypto)
// so @iris/audit stays Node-free and the digest stays compact (8 hex chars).
export function fnv1a32hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
