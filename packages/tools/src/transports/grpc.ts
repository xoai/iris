// gRPC transport over node:http2: POST /<svc>/<method> with real
// gRPC length-prefix framing (1 compression byte = 0, 4-byte big-endian length,
// then the message) and a pluggable codec. The JSON codec keeps it zero-dep;
// protobuf is a future codec behind the same `GrpcCodec` seam. The in-process
// round-trip proves framing + codec — NOT protobuf interop (manual-only).
// Host-side (node:http2).
import http2 from "node:http2";
import type { Json } from "@irisrun/core";
import type { Transport, ToolResult } from "../invoker.ts";
import { locationHandle, messageOf, toolFailure } from "../invoker.ts";

// The codec seam: bytes <-> Json. JSON now; protobuf is a future implementation.
export interface GrpcCodec {
  name: string;
  encode(value: Json): Uint8Array;
  decode(bytes: Uint8Array): Json;
}

export function jsonCodec(): GrpcCodec {
  return {
    name: "json",
    encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
    decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Json,
  };
}

// Prefix a payload with the gRPC length-prefix frame header.
export function frameMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0; // compression flag: none
  new DataView(out.buffer).setUint32(1, payload.length, false); // big-endian length
  out.set(payload, 5);
  return out;
}

export interface FrameReader {
  // Append a chunk; return every complete message now available (possibly none).
  push(chunk: Uint8Array): Uint8Array[];
}

// Stateful reassembler: gRPC frames can span / share TCP chunks, so buffer until
// a full header + body is present, emitting messages as they complete.
export function makeFrameReader(): FrameReader {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf);
      merged.set(chunk, buf.length);
      buf = merged;
      const messages: Uint8Array[] = [];
      while (buf.length >= 5) {
        const length = new DataView(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        ).getUint32(1, false);
        if (buf.length < 5 + length) break; // header present, body still partial
        messages.push(buf.slice(5, 5 + length));
        buf = buf.slice(5 + length);
      }
      return messages;
    },
  };
}

export interface GrpcOptions {
  timeoutMs?: number;
  codec?: GrpcCodec;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function makeGrpcTransport(options: GrpcOptions = {}): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const codec = options.codec ?? jsonCodec();
  return {
    invoke(contract, input) {
      // grpc://<authority>/<svc>/<method>
      const rest = locationHandle(contract.location, "grpc");
      const slash = rest.indexOf("/");
      if (slash < 0) {
        return Promise.resolve(
          toolFailure(
            `grpc location must be grpc://host:port/svc/method, got "${contract.location}"`,
            "bad_location",
          ),
        );
      }
      const authority = rest.slice(0, slash);
      const path = rest.slice(slash);
      return unaryCall(authority, path, input, codec, timeoutMs);
    },
  };
}

function unaryCall(
  authority: string,
  path: string,
  input: Json,
  codec: GrpcCodec,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const client = http2.connect(`http://${authority}`);
    const reader = makeFrameReader();
    let responsePayload: Uint8Array | null = null;
    let frameCount = 0;
    let grpcStatus: number | null = null;
    let grpcMessage = "";
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // session already closing
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(toolFailure(`grpc call timed out after ${timeoutMs}ms`, "timeout")),
      timeoutMs,
    );

    client.on("error", (e) =>
      finish(toolFailure(`grpc connection failed: ${messageOf(e)}`, "connect_failed")),
    );

    const readStatus = (
      headers: http2.IncomingHttpHeaders | http2.IncomingHttpStatusHeader,
    ): void => {
      const status = (headers as Record<string, unknown>)["grpc-status"];
      if (status !== undefined) grpcStatus = Number(status);
      const message = (headers as Record<string, unknown>)["grpc-message"];
      if (message !== undefined) grpcMessage = String(message);
    };

    const req = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": `application/grpc+${codec.name}`,
      te: "trailers",
    });

    req.on("response", (headers) => readStatus(headers));
    req.on("trailers", (trailers) => readStatus(trailers));
    req.on("error", (e) =>
      finish(toolFailure(`grpc request failed: ${messageOf(e)}`, "request_failed")),
    );
    req.on("data", (chunk: Buffer) => {
      for (const message of reader.push(new Uint8Array(chunk))) {
        frameCount++;
        if (responsePayload === null) responsePayload = message; // unary: the first frame is the response
      }
    });
    req.on("end", () => {
      if (grpcStatus !== null && grpcStatus !== 0) {
        finish(
          toolFailure(
            `grpc status ${grpcStatus}${grpcMessage ? `: ${grpcMessage}` : ""}`,
            `grpc_${grpcStatus}`,
          ),
        );
        return;
      }
      if (responsePayload === null) {
        finish(toolFailure("grpc response carried no message frame", "no_response"));
        return;
      }
      if (frameCount > 1) {
        // A unary call expects exactly one message frame. Surface extra frames
        // loudly rather than silently dropping them (a streaming codec is future).
        finish(
          toolFailure(
            `unary grpc call received ${frameCount} message frames; expected exactly 1`,
            "unexpected_frames",
          ),
        );
        return;
      }
      try {
        finish({ ok: true, value: codec.decode(responsePayload) });
      } catch (e) {
        finish(
          toolFailure(
            `failed to decode grpc response: ${messageOf(e)}`,
            "malformed_response",
          ),
        );
      }
    });

    req.end(Buffer.from(frameMessage(codec.encode(input))));
  });
}
