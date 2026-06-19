// The docker backend's network-policy validation is install-free testable: the
// refusal happens BEFORE any `docker` invocation, so these run without Docker.
// Proves the secure-floor fix — a per-host allowlist is refused loudly (never
// silently widened to open egress). The real container path is the manual smoke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerSession } from "@iris/sandbox";

test("docker: a per-host allowlist at create is refused loudly (no silent open egress)", async () => {
  await assert.rejects(
    () => createDockerSession({ network: { allow: ["safe.host"] } }),
    /egress proxy/,
  );
});

test("docker: setNetworkPolicy to an allowlist is refused loudly", async () => {
  const s = await createDockerSession({ network: "deny-all" });
  await assert.rejects(() => s.setNetworkPolicy({ allow: ["safe.host"] }), /egress proxy/);
});

test("docker: the supported policies (deny-all, allow-all) are accepted at create", async () => {
  const denied = await createDockerSession({ network: "deny-all" });
  assert.match(denied.id, /^docker:/);
  const open = await createDockerSession({ network: "allow-all" });
  assert.match(open.id, /^docker:/);
});
