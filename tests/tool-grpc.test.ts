import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import {
  makeGrpcTransport,
  jsonCodec,
  frameMessage,
  makeFrameReader,
} from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";
import type { Json } from "@irisrun/core";

// An in-process HTTP/2 server speaking gRPC framing + the JSON codec. It writes
// the response frame in TWO chunks to force the client to reassemble a partial
// frame, and sends grpc-status in trailers (or non-OK in headers for /fail).
function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const reader = makeFrameReader();
        const msgs = reader.push(new Uint8Array(Buffer.concat(chunks)));
        const input = jsonCodec().decode(msgs[0]) as { n: number };
        const path = String(headers[":path"]);
        if (path.toLowerCase().includes("fail")) {
          // trailers-only non-OK response (grpc-status in headers)
          stream.respond({
            ":status": 200,
            "content-type": "application/grpc+json",
            "grpc-status": "2",
            "grpc-message": "intentional failure",
          });
          stream.end();
          return;
        }
        if (path.toLowerCase().includes("multi")) {
          // two complete message frames in one unary response — must be refused
          const f1 = frameMessage(jsonCodec().encode({ part: 1 }));
          const f2 = frameMessage(jsonCodec().encode({ part: 2 }));
          stream.respond(
            { ":status": 200, "content-type": "application/grpc+json" },
            { waitForTrailers: true },
          );
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
          stream.write(Buffer.from(f1));
          stream.write(Buffer.from(f2));
          stream.end();
          return;
        }
        const frame = frameMessage(jsonCodec().encode({ doubled: input.n * 2 }));
        stream.respond(
          { ":status": 200, "content-type": "application/grpc+json" },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () => {
          stream.sendTrailers({ "grpc-status": "0" });
        });
        // split the frame to exercise partial-frame reassembly on the client
        stream.write(Buffer.from(frame.slice(0, 3)));
        stream.write(Buffer.from(frame.slice(3)));
        stream.end();
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function contract(location: string): ToolContract {
  return {
    name: "double",
    description: "double a number",
    inputSchema: {},
    transport: "grpc",
    location,
    retrySafe: false,
  };
}

test("T4: gRPC round-trips in-process through http2 (framing + JSON codec) → {ok:true}", async () => {
  const { port, close } = await startServer();
  try {
    const grpc = makeGrpcTransport();
    const res = await grpc.invoke(
      contract(`grpc://localhost:${port}/calc.Calc/Double`),
      { n: 21 },
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok ? res.value : null, { doubled: 42 });
  } finally {
    await close();
  }
});

test("T4: a non-OK gRPC status → {ok:false}", async () => {
  const { port, close } = await startServer();
  try {
    const grpc = makeGrpcTransport();
    const res = await grpc.invoke(
      contract(`grpc://localhost:${port}/calc.Calc/Fail`),
      { n: 1 },
    );
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.error.message : "", /intentional failure/);
  } finally {
    await close();
  }
});

test("T4: a unary response with multiple message frames is surfaced loudly (no silent drop)", async () => {
  const { port, close } = await startServer();
  try {
    const grpc = makeGrpcTransport();
    const res = await grpc.invoke(
      contract(`grpc://localhost:${port}/calc.Calc/Multi`),
      { n: 1 },
    );
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.error.code, "unexpected_frames");
  } finally {
    await close();
  }
});

test("T4: the frame reader reassembles a message delivered one byte at a time", () => {
  const value: Json = { hello: "world", n: 7 };
  const frame = frameMessage(jsonCodec().encode(value));
  const reader = makeFrameReader();
  let out: Uint8Array[] = [];
  for (const byte of frame) out = out.concat(reader.push(Uint8Array.of(byte)));
  assert.equal(out.length, 1);
  assert.deepEqual(jsonCodec().decode(out[0]), value);
});
