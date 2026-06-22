// C2 (sandbox-runtime-wiring): the subprocess transport gains a zero-value-off
// `sandbox` option. When set, the tool runs via the SandboxExecutor (request line on
// stdin, response line on stdout) instead of a bare spawn; the response parsing is
// shared. Absent → the spawn path runs verbatim (off-path unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSubprocessTransport } from "@irisrun/tools";
import type { ToolContract, SandboxExecutor } from "@irisrun/tools";
import { inMemoryBackend } from "@irisrun/sandbox";

const contract: ToolContract = {
  name: "toolbin",
  description: "test tool",
  inputSchema: {},
  transport: "subprocess",
  location: "subprocess://toolbin",
  retrySafe: true,
};

// A SandboxExecutor that runs the tool INSIDE an inMemory sandbox via the `commands`
// hook: the JSON request arrives as stdin; the handler emits a valid response line.
const sandbox: SandboxExecutor = {
  async exec(spec, stdin) {
    const session = await inMemoryBackend().create({
      commands: {
        [spec.command]: (input) => {
          const req = JSON.parse(new TextDecoder().decode(input)) as { id: string; input: unknown };
          return {
            stdout: JSON.stringify({ id: req.id, ok: true, value: { echoed: req.input } }) + "\n",
            stderr: "",
            exit: 0,
          };
        },
      },
    });
    return session.run(`${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), { stdin });
  },
};

test("subprocess transport routes through a SandboxExecutor when configured", async () => {
  const transport = makeSubprocessTransport({ toolbin: { command: "toolbin" } }, { sandbox });
  const res = await transport.invoke(contract, { hi: 1 });
  assert.deepEqual(res, { ok: true, value: { echoed: { hi: 1 } } });
});

test("a sandbox executor that throws maps to a clean tool failure (no hang)", async () => {
  const boom: SandboxExecutor = { exec: () => Promise.reject(new Error("backend down")) };
  const transport = makeSubprocessTransport({ toolbin: { command: "toolbin" } }, { sandbox: boom });
  const res = await transport.invoke(contract, {});
  assert.equal(res.ok, false);
});

test("absent sandbox → the real spawn path still runs (off-path unchanged)", async () => {
  const NODE = process.execPath;
  const ECHO = `let b="";process.stdin.on("data",d=>{b+=d;const n=b.indexOf("\\n");if(n<0)return;const r=JSON.parse(b.slice(0,n));process.stdout.write(JSON.stringify({id:r.id,ok:true,value:{spawned:true}})+"\\n");process.exit(0);});`;
  const transport = makeSubprocessTransport({ toolbin: { command: NODE, args: ["-e", ECHO] } });
  const res = await transport.invoke(contract, {});
  assert.deepEqual(res, { ok: true, value: { spawned: true } });
});
