import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, encode, decode, canonicalEqual } from "@iris/core";
import type { Json } from "@iris/core";

test("canonicalize: object key order is irrelevant", () => {
  const a: Json = { a: 1, b: 2, nested: { x: 1, y: 2 } };
  const b: Json = { b: 2, nested: { y: 2, x: 1 }, a: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.ok(canonicalEqual(a, b));
});

test("canonicalize: array order is preserved", () => {
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
  assert.equal(canonicalize([1, 2, 3]), "[1,2,3]");
});

test("encode/decode: round-trip is structurally identity", () => {
  const x: Json = {
    s: "hi",
    n: 42,
    b: true,
    z: null,
    arr: [1, { k: "v" }, [2, 3]],
    obj: { deep: { deeper: [true, false] } },
  };
  const back = decode(encode(x));
  assert.ok(canonicalEqual(x, back));
  assert.deepEqual(back, x);
});

test("canonicalize: rejects non-canonical values loudly", () => {
  assert.throws(() => canonicalize(NaN as unknown as Json), /non-finite/);
  assert.throws(() => canonicalize(Infinity as unknown as Json), /non-finite/);
  assert.throws(
    () => canonicalize(undefined as unknown as Json),
    /unsupported value of type "undefined"/,
  );
  assert.throws(
    () => canonicalize(10n as unknown as Json),
    /unsupported value of type "bigint"/,
  );
  assert.throws(
    () => canonicalize(new Map() as unknown as Json),
    /non-plain object/,
  );
  assert.throws(
    () => canonicalize({ a: undefined } as unknown as Json),
    /undefined value/,
  );
});
