// C1 (sandbox-runtime-wiring): SandboxSession.run gains optional stdin + a
// test-facing `commands` hook on the inMemory backend, so the tool request/response
// protocol can be exercised in CI without Docker. Back-compat: run(cmd) with no opts
// is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inMemoryBackend, createInMemorySession } from "@irisrun/sandbox";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("inMemory run delivers stdin to a registered command handler", async () => {
  const session = await createInMemorySession({
    commands: { cat: (stdin) => ({ stdout: dec(stdin), stderr: "", exit: 0 }) },
  });
  const res = await session.run("cat", { stdin: enc("hello\n") });
  assert.equal(res.stdout, "hello\n");
  assert.equal(res.exit, 0);
});

test("a registered command receives the parsed args", async () => {
  const session = await createInMemorySession({
    commands: { greet: (_stdin, args) => ({ stdout: `hi ${args.join(",")}`, stderr: "", exit: 0 }) },
  });
  const res = await session.run("greet alice bob");
  assert.equal(res.stdout, "hi alice,bob");
});

test("run without opts and unknown commands behave as before (back-compat)", async () => {
  const session = await createInMemorySession();
  assert.equal((await session.run("echo hi")).stdout, "hi");
  const unknown = await session.run("nope");
  assert.equal(unknown.exit, 1);
  assert.match(unknown.stderr, /unknown command/);
});

test("backend().create wires the commands hook too", async () => {
  const session = await inMemoryBackend().create({
    commands: { ping: () => ({ stdout: "pong", stderr: "", exit: 0 }) },
  });
  assert.equal((await session.run("ping")).stdout, "pong");
});
