import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import {
  resolveLocality,
  contractDigest,
  makeToolInvoker,
  makeSubprocessTransport,
  makeGrpcTransport,
  jsonCodec,
  frameMessage,
  makeFrameReader,
} from "@iris/tools";
import type { LogicalTool, LocalityOptions } from "@iris/tools";

const NODE = process.execPath;

// local realization: a subprocess child returning value {greeting}.
const SUB_GREET = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, value: { greeting: "hi " + (req.input.who || "world") } }) + "\\n");
  process.exit(0);
});
`;

// remote realization: an http2/gRPC server returning the SAME {greeting} value.
function startGrpcGreeter(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream: http2.ServerHttp2Stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const msgs = makeFrameReader().push(new Uint8Array(Buffer.concat(chunks)));
        const input = jsonCodec().decode(msgs[0]) as { who?: string };
        const frame = frameMessage(
          jsonCodec().encode({ greeting: "hi " + (input.who || "world") }),
        );
        stream.respond(
          { ":status": 200, "content-type": "application/grpc+json" },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        stream.end(Buffer.from(frame));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const tool: LogicalTool = {
  name: "greet",
  description: "greet a name",
  inputSchema: { type: "object", properties: { who: { type: "string" } } },
  retrySafe: false,
};

test("T5: the SAME tool runs local(subprocess) and remote(grpc) — same digest, equivalent result", async () => {
  const { port, close } = await startGrpcGreeter();
  try {
    const options: LocalityOptions = {
      local: { transport: "subprocess", location: "subprocess://greet" },
      remote: { transport: "grpc", location: `grpc://localhost:${port}/g.Greeter/Greet` },
    };

    const localContract = resolveLocality(tool, "local", options);
    const remoteContract = resolveLocality(tool, "remote", options);

    // No contract change across localities: the model-perceived surface (and so
    // the digest) is identical; only transport/location differ.
    assert.equal(localContract.transport, "subprocess");
    assert.equal(remoteContract.transport, "grpc");
    assert.equal(contractDigest(localContract), contractDigest(remoteContract));

    const invoker = makeToolInvoker({
      subprocess: makeSubprocessTransport({
        greet: { command: NODE, args: ["-e", SUB_GREET] },
      }),
      grpc: makeGrpcTransport(),
    });

    const local = await invoker.invoke(localContract, { who: "iris" });
    const remote = await invoker.invoke(remoteContract, { who: "iris" });

    assert.deepEqual(local, remote);
    assert.deepEqual(local.ok ? local.value : null, { greeting: "hi iris" });
  } finally {
    await close();
  }
});

test("T5: a requested locality with no configured transport → a precise refusal", () => {
  const options: LocalityOptions = {
    local: { transport: "subprocess", location: "subprocess://greet" },
  };
  assert.throws(
    () => resolveLocality(tool, "remote", options),
    /no transport configured for locality "remote"/,
  );
});

test("T5: a locality bound to the wrong transport kind is rejected", () => {
  const options = {
    local: { transport: "grpc", location: "grpc://x/y/z" },
  } as unknown as LocalityOptions;
  assert.throws(() => resolveLocality(tool, "local", options), /must use one of/);
});
