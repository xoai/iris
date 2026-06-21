// Wire conformance cases into a test runner without depending on one. `testFn` is
// structurally `node:test`'s `test`; any `(name, fn)` runner works.
import type { ConformanceCase } from "./types.ts";

type TestFn = (name: string, fn: () => Promise<void> | void) => unknown;

export function register(cases: ConformanceCase[], testFn: TestFn): void {
  for (const c of cases) testFn(c.name, c.fn);
}
