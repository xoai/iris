// Proves the conformance suite has TEETH: a store that violates the CAS contract
// must FAIL at least one case. Without this, a green suite could mean "the harness
// asserts nothing" — this is the meta-check that the certification certifies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStoreConformance } from "@irisrun/store-conformance";
import { MemoryStateStore } from "@irisrun/store-memory";
import type { CasResult, Version } from "@irisrun/core";

// A store that VIOLATES compare-and-swap: every cas "wins" with an ever-rising
// version, so a second null-cas (which MUST lose) wrongly succeeds.
class BrokenCasStore extends MemoryStateStore {
  private v = 0;
  override async cas(
    _key: string,
    _expected: Version | null,
    _next: Uint8Array,
  ): Promise<CasResult> {
    this.v += 1;
    return { ok: true, version: this.v }; // always wins — wrong
  }
}

test("teeth: the suite FAILS a store that violates the CAS contract", async () => {
  const cases = runStoreConformance(() => new BrokenCasStore());
  let failures = 0;
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failures += 1;
    }
  }
  assert.ok(failures > 0, "a CAS-violating store must fail at least one conformance case");
});
