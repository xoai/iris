// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob). Pushes a built local
// OCI layout to a REAL registry and pulls it back (and, where available, signs it
// with cosign). The install-free path is the local OCI layout (tests/cli.test.ts);
// this is the real-registry path.
//
//   IRIS_OCI_SMOKE=1 IRIS_OCI_LAYOUT=./image IRIS_OCI_REF=ghcr.io/you/agent:latest \
//     node manual/oci-registry-smoke.ts
//
// Requires an OCI client (`oras` or `docker`) on PATH and registry auth already
// configured. cosign signing runs only if `cosign` is present and IRIS_COSIGN=1.
import { execFile } from "node:child_process";

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ exit: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function main() {
  if (process.env.IRIS_OCI_SMOKE !== "1") {
    console.log("skip: set IRIS_OCI_SMOKE=1 (+ IRIS_OCI_LAYOUT, IRIS_OCI_REF, an OCI client + auth) to run");
    return;
  }
  const layout = process.env.IRIS_OCI_LAYOUT || "./image";
  const ref = process.env.IRIS_OCI_REF;
  if (!ref) {
    console.error("oci-smoke FAIL: IRIS_OCI_REF (e.g. ghcr.io/you/agent:latest) is required");
    process.exit(1);
  }
  // push the local OCI layout to the registry (oras supports --oci-layout)
  const push = await sh("oras", ["push", "--oci-layout", `${layout}:latest`, ref]);
  if (push.exit !== 0) {
    console.error(`oci-smoke FAIL: push exited ${push.exit}: ${push.stderr.trim()}`);
    process.exit(1);
  }
  // pull it back to a fresh layout
  const pull = await sh("oras", ["pull", "--oci-layout", `${layout}-pulled:latest`, ref]);
  if (pull.exit !== 0) {
    console.error(`oci-smoke FAIL: pull exited ${pull.exit}: ${pull.stderr.trim()}`);
    process.exit(1);
  }
  if (process.env.IRIS_COSIGN === "1") {
    const sign = await sh("cosign", ["sign", "--yes", ref]);
    console.log(sign.exit === 0 ? "oci-smoke: cosign signed" : `oci-smoke: cosign skipped/failed (${sign.stderr.trim()})`);
  }
  console.log("oci-smoke: PASS (push + pull round-trip against a real registry)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
