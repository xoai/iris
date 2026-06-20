// MANUAL smoke — NOT in the unit suite, NOT typechecked (tests/manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob). Run with Docker:
//   IRIS_DOCKER_SMOKE=1 node tests/manual/docker-smoke.ts
// Proves the REAL docker backend: a /workspace volume round-trip, deny-all egress
// blocking, that a secret never leaks into the container (env / args / volume),
// AND — the un-gated path — real brokered egress through the sidecar EgressProxy:
// an allowlisted host is reachable, a non-allowlisted host is blocked at the
// proxy, the brokered secret arrives UPSTREAM, and the secret never enters the
// container.
import { createDockerSession, startEgressProxy, makeCredentialBroker } from "@irisrun/sandbox";
import http from "node:http";

function check(cond, msg) {
  if (!cond) {
    console.error("docker-smoke FAIL: " + msg);
    process.exit(1);
  }
}

// A host-side fake upstream that records what each request carried (server-side)
// and replies with a fixed body — the proxy forwards the container's request here.
function makeUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({
      auth: req.headers["authorization"],
      marker: req.headers["x-iris-secret"],
    });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  if (process.env.IRIS_DOCKER_SMOKE !== "1") {
    console.log("skip: set IRIS_DOCKER_SMOKE=1 (and have Docker installed) to run this smoke");
    return;
  }
  const SECRET = "sk-docker-smoke-secret";
  const s = await createDockerSession({ network: "deny-all", env: { TOOL_MODE: "prod" } });

  // 1) /workspace round-trips through a real container volume
  await s.writeFile("/workspace/in.txt", new TextEncoder().encode("hello"));
  const cat = await s.run("cat /workspace/in.txt");
  check(cat.exit === 0 && cat.stdout.trim() === "hello", "workspace round-trip");

  // 2) deny-all (--network none) blocks egress
  const net = await s.run("wget -T 3 -q -O- http://example.com || echo BLOCKED");
  check(net.stdout.includes("BLOCKED") || net.exit !== 0, "deny-all blocks network");

  // 3) the secret must NEVER enter the container — the docker backend passes no
  //    secret via -e / args / volume (it is brokered host-side at the proxy)
  const env = await s.run("env");
  check(!env.stdout.includes(SECRET), "secret must not appear in container env");
  const ws = await s.run("cat /workspace/in.txt");
  check(!ws.stdout.includes(SECRET), "secret must not appear in /workspace");

  console.log("docker-smoke: PASS (workspace round-trip, deny-all egress, no secret leak)");

  // 4) REAL brokered egress through the sidecar EgressProxy (the un-gated path).
  //    The proxy binds 0.0.0.0 so the container reaches it via host.docker.internal;
  //    it forwards to the host-side upstream on 127.0.0.1 (allowlisted).
  const upstream = await makeUpstream();
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const proxy = await startEgressProxy({ policy: { allow: ["127.0.0.1"] }, broker, host: "0.0.0.0" });
  try {
    const sb = await createDockerSession({ network: { allow: ["127.0.0.1"] }, egress: proxy });

    // 4a) allowlisted host reachable through the proxy + brokered secret arrives upstream
    const reach = await sb.run(
      `wget -T 5 -q -O- --header="x-iris-secret: API_KEY" http://127.0.0.1:${upstream.port}/ || echo FAILED`,
    );
    check(!reach.stdout.includes("FAILED") && reach.stdout.includes("upstream-ok"),
      "allowlisted host reachable through the proxy");
    check(upstream.received.some((r) => r.auth === `Bearer ${SECRET}`),
      "brokered secret arrived UPSTREAM (added at the proxy)");
    check(upstream.received.every((r) => r.marker === undefined),
      "the x-iris-secret marker was stripped before upstream");

    // 4b) the secret never entered the container
    const benv = await sb.run("env");
    check(!benv.stdout.includes(SECRET), "secret must not appear in container env (brokered path)");

    // 4c) a non-allowlisted host is blocked AT the proxy
    const blocked = await sb.run("wget -T 5 -q -O- http://blocked.invalid/ || echo BLOCKED");
    check(blocked.stdout.includes("BLOCKED") || blocked.exit !== 0,
      "non-allowlisted host blocked at the proxy");

    console.log("docker-smoke: PASS (proxy egress: allowlist + brokered secret upstream + marker stripped + blocked host + no leak)");
  } finally {
    await proxy.close();
    await upstream.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
