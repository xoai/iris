import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  specifiersInDir,
  specifiersInSource,
  classifyForbidden,
  listTsFiles,
} from "./lib/scan-imports.ts";

// repo root = parent of tests/
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE_SRC = join(ROOT, "packages", "core", "src");
const HARNESS_SRC = join(CORE_SRC, "harness");

// A1 — the boundary rule: core imports no host/transport/Node-only package.
test("A1: core/src imports only relative specifiers (no host/transport/Node-only)", () => {
  // Confirm the scan targeted real files (not an empty/typo'd dir). An
  // import-less core is itself clean; the scanner's correctness is proven by
  // the test-the-test case below.
  assert.ok(
    listTsFiles(CORE_SRC).length > 0,
    "expected to scan at least one .ts file in core/src",
  );
  const refs = specifiersInDir(CORE_SRC);
  const offenders = refs
    .map((r) => ({ ...r, reason: classifyForbidden(r.specifier) }))
    .filter((r) => r.reason !== null);
  assert.deepEqual(
    offenders,
    [],
    `core/ must import no host/transport package. Offenders: ${JSON.stringify(offenders, null, 2)}`,
  );
});

// C7 — A1 extends to the harness layer: the kernel, seams, invariants,
// bundle, and tactics are pure deciders that must import only relative core
// modules (no host/transport/provider/Node-only API). Explicit named guard even
// though the recursive A1 scan above already covers core/src.
test("C7: core/harness imports no host/transport/provider/Node-only API", () => {
  const files = listTsFiles(HARNESS_SRC);
  assert.ok(
    files.length >= 8,
    `expected to scan the harness modules (kernel/seams/invariants/bundle + 4 tactics), found ${files.length}`,
  );
  const offenders = specifiersInDir(HARNESS_SRC)
    .map((r) => ({ ...r, reason: classifyForbidden(r.specifier) }))
    .filter((r) => r.reason !== null);
  assert.deepEqual(
    offenders,
    [],
    `core/harness must import only relative core modules. Offenders: ${JSON.stringify(offenders, null, 2)}`,
  );
});

test("A1: core package.json declares zero dependencies", () => {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8"),
  );
  assert.deepEqual(
    pkg.dependencies ?? {},
    {},
    "core must have no runtime dependencies",
  );
});

// Test-the-test: prove the scanner actually catches a violation, so a green
// boundary test means something. Adding a host import is demonstrably caught.
test("A1: scanner catches a planted host import (test-the-test)", () => {
  const plantedBad = `import { DatabaseSync } from 'node:sqlite';\nimport { x } from '@irisrun/store-sqlite';\nexport const y = 1;`;
  const specs = specifiersInSource(plantedBad);
  assert.ok(specs.includes("node:sqlite"), "scanner missed node:sqlite import");
  assert.ok(
    specs.includes("@irisrun/store-sqlite"),
    "scanner missed @irisrun/store-sqlite import",
  );
  assert.equal(classifyForbidden("node:sqlite"), "Node-only builtin");
  assert.equal(classifyForbidden("@irisrun/store-sqlite"), "host/transport package");
  assert.equal(classifyForbidden("@irisrun/store-memory"), "host/transport package");
  assert.equal(classifyForbidden("@irisrun/provider-anthropic"), "host/transport package");
  assert.equal(classifyForbidden("better-sqlite3"), "host/transport package");
  // a relative, in-core import is allowed
  assert.equal(classifyForbidden("./journal.ts"), null);
});

// T9 — A1 extends to the new host packages: @irisrun/core must import neither
// @irisrun/tools nor @irisrun/sandbox. The recursive A1 scan above already fails on ANY
// non-relative import; this named test makes the intent explicit and pins the
// classification.
test("T9: core/src imports neither @irisrun/tools nor @irisrun/sandbox", () => {
  const specs = specifiersInDir(CORE_SRC).map((r) => r.specifier);
  assert.equal(specs.includes("@irisrun/tools"), false, "core must not import @irisrun/tools");
  assert.equal(specs.includes("@irisrun/sandbox"), false, "core must not import @irisrun/sandbox");

  // Both ARE forbidden if attempted — but via the relative-only catch-all (the
  // GENERIC reason), NOT the HOST_DENYLIST (which lists store|host|channel|
  // provider, not tools|sandbox). So assert `!== null` — do NOT expect the
  // "host/transport package" string used for store/provider above.
  assert.notEqual(classifyForbidden("@irisrun/tools"), null);
  assert.notEqual(classifyForbidden("@irisrun/sandbox"), null);
  assert.equal(
    classifyForbidden("@irisrun/tools"),
    "non-relative import (core must be dependency-free)",
  );
  assert.equal(
    classifyForbidden("@irisrun/sandbox"),
    "non-relative import (core must be dependency-free)",
  );
});

// T10 — A1 extends to the image toolchain: @irisrun/core must import neither
// @irisrun/agent nor the `iris` CLI. Same generic-reason classification as the
// packages (HOST_DENYLIST lists store|host|channel|provider, not agent/cli — the
// relative-only catch-all is what bans them; the unscoped `iris` is banned by the
// same catch-all, so the rename @irisrun/cli→iris needs no classifier change).
test("T10: core/src imports neither @irisrun/agent nor the iris CLI", () => {
  const specs = specifiersInDir(CORE_SRC).map((r) => r.specifier);
  assert.equal(specs.includes("@irisrun/agent"), false, "core must not import @irisrun/agent");
  assert.equal(specs.includes("iris-runtime"), false, "core must not import the iris-runtime CLI");
  assert.notEqual(classifyForbidden("@irisrun/agent"), null);
  assert.notEqual(classifyForbidden("iris-runtime"), null);
  assert.equal(
    classifyForbidden("@irisrun/agent"),
    "non-relative import (core must be dependency-free)",
  );
  assert.equal(
    classifyForbidden("iris-runtime"),
    "non-relative import (core must be dependency-free)",
  );
});

// T6 — A1 extends to the new host/transport packages: @irisrun/core must
// import none of @irisrun/store-fs / @irisrun/host / @irisrun/channel-rest. Unlike the
// packages (tools/sandbox/agent/cli, banned via the generic relative-only rule),
// these three MATCH the HOST_DENYLIST (/^@irisrun\/(store|host|channel|provider)/), so
// they classify as the precise "host/transport package" reason — like @irisrun/store-sqlite.
test("T6: core/src imports none of @irisrun/store-fs / @irisrun/host / @irisrun/channel-rest", () => {
  const specs = specifiersInDir(CORE_SRC).map((r) => r.specifier);
  for (const pkg of ["@irisrun/store-fs", "@irisrun/host", "@irisrun/channel-rest"]) {
    assert.equal(specs.includes(pkg), false, `core must not import ${pkg}`);
    // and each is a HOST_DENYLIST hit — the precise host/transport reason, NOT the
    // generic relative-only catch-all used for tools/sandbox/agent/cli.
    assert.equal(
      classifyForbidden(pkg),
      "host/transport package",
      `${pkg} must classify as a host/transport package (store|host|channel denylist)`,
    );
  }
});

// T5 — A1 extends to the channels & observability packages. @irisrun/core must
// import NONE of them. The reasons SPLIT: @irisrun/channel-mcp MATCHES the HOST_DENYLIST
// (the `channel` alternative) → "host/transport package"; @irisrun/inspect / @irisrun/evals
// / @irisrun/observe do NOT match the denylist → the GENERIC relative-only reason (like
// tools/sandbox/agent/cli). Asserting the exact strings makes the distinction load-bearing.
test("T5: core/src imports none of channel-mcp / inspect / evals / observe (with the right per-package reasons)", () => {
  const specs = specifiersInDir(CORE_SRC).map((r) => r.specifier);
  for (const pkg of ["@irisrun/channel-mcp", "@irisrun/inspect", "@irisrun/evals", "@irisrun/observe"]) {
    assert.equal(specs.includes(pkg), false, `core must not import ${pkg}`);
  }
  // channel-mcp is a host/transport package (matches store|host|channel|provider)
  assert.equal(classifyForbidden("@irisrun/channel-mcp"), "host/transport package");
  // the journal-reader packages are NOT on the denylist → the generic reason
  assert.equal(classifyForbidden("@irisrun/inspect"), "non-relative import (core must be dependency-free)");
  assert.equal(classifyForbidden("@irisrun/evals"), "non-relative import (core must be dependency-free)");
  assert.equal(classifyForbidden("@irisrun/observe"), "non-relative import (core must be dependency-free)");
});

// T9 — A1 extends to the edge adapter + the first domain bundle. @irisrun/core must
// import NEITHER. The reasons SPLIT: @irisrun/store-do MATCHES the HOST_DENYLIST (the `store`
// alternative of /^@irisrun\/(store|host|channel|provider)/, exactly like @irisrun/store-fs /
// @irisrun/store-sqlite) → the precise "host/transport package" reason; @irisrun/bundle-coding does
// NOT match the denylist (it deps @irisrun/core only, host-side) → the GENERIC relative-only
// reason (like tools/sandbox/agent/cli/inspect/evals/observe). The scanner needs NO change —
// this only adds the named assertions, making the per-package distinction load-bearing.
test("T9: core/src imports neither @irisrun/store-do nor @irisrun/bundle-coding (with the right per-package reasons)", () => {
  const specs = specifiersInDir(CORE_SRC).map((r) => r.specifier);
  for (const pkg of ["@irisrun/store-do", "@irisrun/bundle-coding"]) {
    assert.equal(specs.includes(pkg), false, `core must not import ${pkg}`);
  }
  // store-do is a host/transport package (matches the `store` denylist alternative)
  assert.equal(classifyForbidden("@irisrun/store-do"), "host/transport package");
  // bundle-coding is NOT on the denylist → the generic dependency-free reason
  assert.equal(
    classifyForbidden("@irisrun/bundle-coding"),
    "non-relative import (core must be dependency-free)",
  );
});
