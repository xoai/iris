// T0 scaffold gate: the new @irisrun/journal-export package resolves via the
// iris-src workspace condition and exports its package marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGE } from "@irisrun/journal-export";

test("@irisrun/journal-export resolves and exports PACKAGE", () => {
  assert.equal(PACKAGE, "@irisrun/journal-export");
});
