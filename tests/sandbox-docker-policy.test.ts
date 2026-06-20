// The docker backend's network-policy validation is install-free testable: the
// decision happens BEFORE any `docker` invocation, so these run without Docker.
// The per-host {allow:[...]} egress is now UN-GATED — but only CONDITIONALLY:
// accepted iff an egress proxy is wired, and STILL refused loudly without one
// (the secure floor — a caller who asked for restriction never silently gets open
// egress). The real container path is the manual smoke. (spec §3/§4.2, ADR-0010.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerSession, startEgressProxy } from "@irisrun/sandbox";

test("docker: WITHOUT a proxy, a per-host allowlist at create is refused loudly (secure floor)", async () => {
  await assert.rejects(
    () => createDockerSession({ network: { allow: ["safe.host"] } }),
    /egress proxy/,
  );
});

test("docker: WITHOUT a proxy, setNetworkPolicy to an allowlist is refused loudly (secure floor)", async () => {
  const s = await createDockerSession({ network: "deny-all" });
  await assert.rejects(() => s.setNetworkPolicy({ allow: ["safe.host"] }), /egress proxy/);
});

test("docker: the supported policies (deny-all, allow-all) are accepted at create", async () => {
  const denied = await createDockerSession({ network: "deny-all" });
  assert.match(denied.id, /^docker:/);
  const open = await createDockerSession({ network: "allow-all" });
  assert.match(open.id, /^docker:/);
});

test("docker: WITH an egress proxy, a per-host allowlist at create is ACCEPTED (un-gated)", async () => {
  const proxy = await startEgressProxy({ policy: { allow: ["safe.host"] }, host: "127.0.0.1" });
  try {
    const s = await createDockerSession({ network: { allow: ["safe.host"] }, egress: proxy });
    assert.match(s.id, /^docker:/);
  } finally {
    await proxy.close();
  }
});

test("docker: WITH an egress proxy, setNetworkPolicy to an allowlist is accepted (hasProxy threads to both call sites)", async () => {
  const proxy = await startEgressProxy({ policy: { allow: ["safe.host"] }, host: "127.0.0.1" });
  try {
    const s = await createDockerSession({ network: "deny-all", egress: proxy });
    await s.setNetworkPolicy({ allow: ["safe.host"] }); // must NOT throw — session has a proxy
  } finally {
    await proxy.close();
  }
});
