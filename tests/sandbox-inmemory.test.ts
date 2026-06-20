// T8 — T-sandbox-secure (inmemory scope). The inmemory
// backend defaults network egress to deny-all (the secure floor), and the
// credential broker injects a secret ONLY at the egress firewall — the secret
// never enters the sandbox's env, command args, /workspace, or output. (The real
// docker broker is asserted by the manual smoke; this is the unit-suite scope.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySession, makeCredentialBroker, inMemoryBackend } from "@irisrun/sandbox";

const SECRET = "sk-supersecret-123";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

test("T8: the inmemory backend's name is 'inmemory' and it creates a session", async () => {
  const backend = inMemoryBackend();
  assert.equal(backend.name, "inmemory");
  const s = await backend.create();
  assert.ok(s.id.length > 0);
});

test("T8: /workspace read/write round-trips; a missing file fails loudly", async () => {
  const s = await createInMemorySession();
  await s.writeFile("/workspace/a.txt", enc("hi"));
  assert.equal(dec(await s.readFile("/workspace/a.txt")), "hi");
  await assert.rejects(() => s.readFile("/workspace/missing.txt"), /no such file/i);
  await assert.rejects(() => s.writeFile("/etc/passwd", enc("x")), /\/workspace/);
});

test("T8: network defaults to deny-all — a fetch is blocked and nothing leaves the box", async () => {
  const s = await createInMemorySession(); // no network opt → deny-all
  const r = await s.run("fetch api.example.com");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr, /denied/i);
  assert.equal(s.egress.length, 0, "nothing egressed under deny-all");
});

test("T8: credential broker injects the secret at egress but NEVER into any sandbox surface", async () => {
  const broker = makeCredentialBroker({ API_KEY: SECRET });
  const s = await createInMemorySession({
    network: { allow: ["api.example.com"] },
    broker,
    env: { TOOL_MODE: "prod" },
  });
  await s.writeFile("/workspace/notes.txt", enc("nothing secret here"));

  // the sandbox references the secret BY NAME — never by value
  const r = await s.run("fetch api.example.com secret:API_KEY");
  assert.equal(r.exit, 0);

  // brokering happened at the egress firewall: the OUTBOUND request carries it
  assert.equal(s.egress.length, 1);
  assert.ok(
    JSON.stringify(s.egress[0]).includes(SECRET),
    "the egressed request must carry the brokered secret",
  );

  // the secret appears in NO sandbox-visible surface
  assert.equal(r.stdout.includes(SECRET), false, "not in stdout");
  assert.equal(r.stderr.includes(SECRET), false, "not in stderr");
  assert.equal(JSON.stringify(s.env).includes(SECRET), false, "not in env");
  assert.equal(dec(await s.readFile("/workspace/notes.txt")).includes(SECRET), false, "not in /workspace");
});

test("T8: a brokered request for an unknown secret fails loudly — no silent egress", async () => {
  const broker = makeCredentialBroker({});
  const s = await createInMemorySession({ network: "allow-all", broker });
  const r = await s.run("fetch api.example.com secret:MISSING");
  assert.notEqual(r.exit, 0);
  assert.equal(s.egress.length, 0);
});

test("T8: setNetworkPolicy tightens egress at runtime", async () => {
  const s = await createInMemorySession({ network: "allow-all" });
  assert.equal((await s.run("fetch api.example.com")).exit, 0);
  await s.setNetworkPolicy("deny-all");
  assert.notEqual((await s.run("fetch api.example.com")).exit, 0);
});
