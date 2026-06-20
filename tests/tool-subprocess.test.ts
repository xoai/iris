import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeToolInvoker,
  makeInProcessTransport,
  makeSubprocessTransport,
} from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";

const NODE = process.execPath;

// A REAL child tool: reads one line-JSON request from stdin, echoes the input
// back inside the value, writes one response line, exits 0.
const ECHO_TOOL = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, value: { echoed: req.input } }) + "\\n");
  process.exit(0);
});
`;

// Exits non-zero WITHOUT responding.
const CRASH_TOOL = `process.exit(3);`;

// Responds with a non-JSON line.
const MALFORMED_TOOL = `
process.stdin.on("data", () => {
  process.stdout.write("this is not json\\n");
  process.exit(0);
});
`;

// Reads stdin but NEVER responds — must be bounded by the timeout.
const HANG_TOOL = `process.stdin.resume(); setInterval(() => {}, 1000);`;

function contract(
  transport: ToolContract["transport"],
  location: string,
): ToolContract {
  return {
    name: "echo",
    description: "echo tool",
    inputSchema: {},
    transport,
    location,
    retrySafe: false,
  };
}

test("T2: subprocess transport invokes a REAL node child over line-delimited JSON", async () => {
  const sp = makeSubprocessTransport({
    echo: { command: NODE, args: ["-e", ECHO_TOOL] },
  });
  const res = await sp.invoke(contract("subprocess", "subprocess://echo"), {
    hi: 1,
  });
  assert.deepEqual(res, { ok: true, value: { echoed: { hi: 1 } } });
});

test("T2: subprocess non-zero exit → {ok:false}", async () => {
  const sp = makeSubprocessTransport({
    crash: { command: NODE, args: ["-e", CRASH_TOOL] },
  });
  const res = await sp.invoke(contract("subprocess", "subprocess://crash"), {});
  assert.equal(res.ok, false);
});

test("T2: subprocess malformed (non-JSON) response line → {ok:false}", async () => {
  const sp = makeSubprocessTransport({
    bad: { command: NODE, args: ["-e", MALFORMED_TOOL] },
  });
  const res = await sp.invoke(contract("subprocess", "subprocess://bad"), {});
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "malformed_response");
});

test("T2: a hung child is bounded by a timeout → {ok:false}", async () => {
  const sp = makeSubprocessTransport(
    { hang: { command: NODE, args: ["-e", HANG_TOOL] } },
    { timeoutMs: 150 },
  );
  const res = await sp.invoke(contract("subprocess", "subprocess://hang"), {});
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "timeout");
});

test("T2: an unregistered subprocess location → loud {ok:false}", async () => {
  const sp = makeSubprocessTransport({});
  const res = await sp.invoke(contract("subprocess", "subprocess://nope"), {});
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "unknown_tool");
});

test("T2: in-process transport calls a registered fn; the invoker dispatches by transport", async () => {
  const ip = makeInProcessTransport({
    adder: (input) => {
      const { a, b } = input as { a: number; b: number };
      return { sum: a + b };
    },
  });
  const invoker = makeToolInvoker({ "in-process": ip });
  const res = await invoker.invoke(contract("in-process", "inproc://adder"), {
    a: 2,
    b: 3,
  });
  assert.deepEqual(res, { ok: true, value: { sum: 5 } });
});

test("T2: in-process fn that throws → mapped {ok:false} (no leak)", async () => {
  const ip = makeInProcessTransport({
    boom: () => {
      throw new Error("kaboom");
    },
  });
  const res = await ip.invoke(contract("in-process", "inproc://boom"), {});
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error.message : "", /kaboom/);
});

test("T2: invoker with no transport for the contract's transport → precise {ok:false}", async () => {
  const invoker = makeToolInvoker({});
  const res = await invoker.invoke(contract("grpc", "grpc://x/y/z"), {});
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "no_transport");
  assert.match(res.ok === false ? res.error.message : "", /no transport/i);
});
