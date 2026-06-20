// Matrix invariants. The compatibility matrix is
// conformance-tested DATA; these pins keep the data honest: stable unique ids, valid
// protocols, the note↔replaySafety contract, and — for replay-safe entries — that the
// baseUrl is the FULL endpoint URL ending in the protocol's path suffix (the T9.3
// round-trip precondition, since the adapters POST opts.baseUrl verbatim).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPAT_MATRIX,
  entriesByProtocol,
  findEntry,
  type CompatEntry,
} from "@irisrun/provider-compat";

const PROTOCOLS = new Set(["openai", "anthropic"]);
const SUFFIX: Record<string, string> = {
  openai: "/chat/completions",
  anthropic: "/messages",
};

test("compat: ids are unique and lowercase-kebab", () => {
  const ids = COMPAT_MATRIX.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in the matrix");
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, `id "${id}" is not lowercase-kebab`);
  }
});

test("compat: every entry has a known protocol and a non-empty label", () => {
  for (const e of COMPAT_MATRIX) {
    assert.ok(PROTOCOLS.has(e.protocol), `entry ${e.id} has unknown protocol ${e.protocol}`);
    assert.ok(e.label.length > 0, `entry ${e.id} has an empty label`);
    assert.ok(e.envKey.length > 0, `entry ${e.id} has an empty envKey`);
  }
});

test("compat: note ↔ replaySafety contract is exact", () => {
  for (const e of COMPAT_MATRIX) {
    if (e.replaySafety === "replay-safe") {
      assert.equal(e.note, "", `replay-safe entry ${e.id} must have an empty note`);
    } else {
      assert.equal(e.replaySafety, "known-divergent", `entry ${e.id} has an unknown replaySafety`);
      assert.ok(e.note.length > 0, `known-divergent entry ${e.id} must name its divergence in note`);
    }
  }
});

test("compat: every baseUrl is a valid http(s) URL", () => {
  for (const e of COMPAT_MATRIX) {
    let u: URL;
    assert.doesNotThrow(() => {
      u = new URL(e.baseUrl);
    }, `entry ${e.id} baseUrl is not a valid URL`);
    u = new URL(e.baseUrl);
    assert.ok(u.protocol === "http:" || u.protocol === "https:", `entry ${e.id} baseUrl is not http(s)`);
  }
});

test("compat: replay-safe baseUrl is the FULL endpoint (ends with the protocol path suffix)", () => {
  for (const e of COMPAT_MATRIX) {
    if (e.replaySafety !== "replay-safe") continue; // known-divergent may template/query the URL
    const path = new URL(e.baseUrl).pathname; // strip any query
    assert.ok(
      path.endsWith(SUFFIX[e.protocol]),
      `replay-safe ${e.id}: path "${path}" must end with "${SUFFIX[e.protocol]}" so --base-url works directly`,
    );
  }
});

test("compat: entriesByProtocol partitions the matrix in order", () => {
  const oa = entriesByProtocol("openai");
  const an = entriesByProtocol("anthropic");
  assert.equal(oa.length + an.length, COMPAT_MATRIX.length, "every entry belongs to exactly one protocol");
  assert.ok(oa.every((e: CompatEntry) => e.protocol === "openai"));
  assert.ok(an.every((e: CompatEntry) => e.protocol === "anthropic"));
  // order preserved (the render relies on this)
  assert.deepEqual(oa.map((e) => e.id), COMPAT_MATRIX.filter((e) => e.protocol === "openai").map((e) => e.id));
});

test("compat: findEntry resolves a known id and is undefined otherwise", () => {
  assert.equal(findEntry("groq")?.protocol, "openai");
  assert.equal(findEntry("anthropic")?.protocol, "anthropic");
  assert.equal(findEntry("no-such-endpoint"), undefined);
});

test("compat: the matrix covers both protocols and is frozen", () => {
  assert.ok(entriesByProtocol("openai").length >= 2, "expect multiple OpenAI-protocol endpoints");
  assert.ok(entriesByProtocol("anthropic").length >= 2, "expect multiple Anthropic-protocol endpoints");
  assert.ok(Object.isFrozen(COMPAT_MATRIX), "COMPAT_MATRIX must be frozen (a stable registry)");
});
