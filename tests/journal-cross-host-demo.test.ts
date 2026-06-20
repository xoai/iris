// T6: the cross-host resume demo runs end-to-end, install-free and deterministic.
// Importing runCrossHostDemo also pulls the demo file into `npm run typecheck`
// (tsc follows imports past tsconfig's tests/examples exclude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCrossHostDemo } from "./examples/cross-host-journal-demo.ts";

test("session migrates fs → sqlite → edge(DO), self-verifies at every hop, finishes byte-identical to control", async () => {
  const r = await runCrossHostDemo();
  assert.equal(r.hops.length, 3, "three hops: laptop, vps, edge");
  for (const h of r.hops) {
    assert.equal(h.verifyOk, true, `${h.host} must self-verify: ${h.contentDigest}`);
    assert.equal(typeof h.contentDigest, "string");
    assert.match(h.contentDigest, /^[0-9a-f]{64}$/, `${h.host} contentDigest is a sha256`);
  }
  assert.equal(r.identical, true, "edge-resumed final state must byte-equal the single-host control");
  assert.equal(typeof r.finishedFinalDigest, "string");
  assert.equal(r.finishedFinalDigest, r.controlFinalDigest);
});
