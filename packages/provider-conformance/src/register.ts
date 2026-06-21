// Wire a list of conformance cases into a test runner WITHOUT this package
// depending on one. `testFn` is structurally `node:test`'s `test`, but any
// runner with a `(name, fn)` signature works — keeping the harness zero-dep and
// usable from a third-party provider's own CI.
import type { ConformanceCase } from "./types.ts";

type TestFn = (name: string, fn: () => Promise<void> | void) => unknown;

export function register(cases: ConformanceCase[], testFn: TestFn): void {
  for (const c of cases) testFn(c.name, c.fn);
}
