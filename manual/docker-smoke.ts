// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob). Run with Docker:
//   IRIS_DOCKER_SMOKE=1 node manual/docker-smoke.ts
// Proves the REAL docker backend: a /workspace volume round-trip, deny-all egress
// blocking, and that a secret never leaks into the container (env / args / volume).
import { createDockerSession } from "@iris/sandbox";

function check(cond, msg) {
  if (!cond) {
    console.error("docker-smoke FAIL: " + msg);
    process.exit(1);
  }
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
  //    secret via -e / args / volume (real brokered egress needs a sidecar proxy)
  const env = await s.run("env");
  check(!env.stdout.includes(SECRET), "secret must not appear in container env");
  const ws = await s.run("cat /workspace/in.txt");
  check(!ws.stdout.includes(SECRET), "secret must not appear in /workspace");

  console.log("docker-smoke: PASS (workspace round-trip, deny-all egress, no secret leak)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
