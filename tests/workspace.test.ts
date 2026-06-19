import { test } from "node:test";
import assert from "node:assert/strict";

// Task 1 (A1 skeleton): the npm workspace links local packages offline and
// cross-package imports resolve at runtime on Node 24 (native TS).
test("workspace: all three packages resolve via their package names", async () => {
  const core = await import("@iris/core");
  const store = await import("@iris/store-sqlite");
  const demo = await import("@iris/demo");
  assert.equal(core.PACKAGE, "@iris/core");
  assert.equal(store.PACKAGE, "@iris/store-sqlite");
  assert.equal(demo.PACKAGE, "@iris/demo");
});
