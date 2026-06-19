// Hand-rolled, zero-dep WebSocket (RFC 6455) for the streaming channel
// (serve-streaming Task 5). Node 24 ships a WebSocket CLIENT but no SERVER, and
// Iris has zero runtime deps — so we implement the handshake (node:crypto SHA-1)
// and a minimal text-frame codec here, consistent with the repo's hand-rolled
// MCP/gRPC/OCI protocols. Text frames only; ping/pong/close handled; client→server
// frames are masked (per spec) and unmasked here; server→client frames are
// unmasked. permessage-deflate is NOT negotiated (the handshake never echoes
// Sec-WebSocket-Extensions), so the built-in client sends raw frames. Host-side.
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Hard cap on a single frame's declared payload (turn-request JSON is tiny). A
// hostile client could otherwise declare a 64-bit length and dribble bytes,
// growing the reassembly buffer without bound (DoS). decodeFrames THROWS on an
// over-cap declaration so the connection is closed loudly rather than OOM'd.
export const MAX_WS_FRAME = 4 * 1024 * 1024; // 4 MiB

/** RFC 6455 accept token: base64( sha1( Sec-WebSocket-Key + magic GUID ) ). */
export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

export function writeHandshake(socket: Duplex, key: string): void {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      "\r\n",
    // NO Sec-WebSocket-Extensions → permessage-deflate refused → raw frames only.
  );
}

export function refuseUpgrade(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

export interface WsFrame {
  fin: boolean;
  opcode: number; // 0 cont, 1 text, 2 binary, 8 close, 9 ping, 10 pong
  masked: boolean; // RFC 6455: client→server frames MUST be masked
  payload: Buffer;
}

/**
 * Parse zero or more COMPLETE frames from `buf`; return them plus the unconsumed
 * tail (a partial frame is left for the next chunk). Client frames are masked; we
 * unmask. Handles 7-bit, 16-bit (126), and 64-bit (127) payload lengths.
 */
export function decodeFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      // 64-bit length branch — kept for spec correctness even though the built-in
      // client uses minimal encoding (Iris memory: don't drop it as "dead code").
      if (p + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(p);
      p += 8;
      if (big > BigInt(MAX_WS_FRAME)) {
        throw new RangeError(`ws frame too large: ${big} > ${MAX_WS_FRAME}`);
      }
      len = Number(big);
    }
    // Reject an over-cap declaration BEFORE allocating/awaiting the payload (DoS guard).
    if (len > MAX_WS_FRAME) throw new RangeError(`ws frame too large: ${len} > ${MAX_WS_FRAME}`);
    let maskKey: Buffer | null = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break; // incomplete payload — wait for more bytes
    let payload: Buffer;
    if (maskKey) {
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ maskKey[i & 3];
    } else {
      payload = Buffer.from(buf.subarray(p, p + len)); // copy out of the shared buffer
    }
    frames.push({ fin, opcode, masked, payload });
    offset = p + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/** Server→client TEXT frame (FIN=1, opcode 0x1, unmasked). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Server close frame (FIN=1, opcode 0x8, 2-byte status code). */
export function encodeCloseFrame(code = 1000): Buffer {
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 2]), body]);
}

/** Server pong frame (FIN=1, opcode 0xA), echoing the ping payload. */
export function encodePongFrame(payload: Buffer): Buffer {
  const len = Math.min(payload.length, 125); // control frames carry < 126 bytes
  return Buffer.concat([Buffer.from([0x8a, len]), payload.subarray(0, len)]);
}

export interface WsFramerCallbacks {
  onText: (text: string) => void;
  onPing: (payload: Buffer) => void;
  onClose: () => void;
}

/**
 * A stateful chunk feeder: buffers partial frames across `data` events, reassembles
 * a fragmented text message (text frame fin=0 then continuation frames), and routes
 * control frames. Returns a `feed(chunk)` function. Unit-testable in isolation.
 */
export function makeWsFramer(cb: WsFramerCallbacks): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0); // annotated: decodeFrames' tail is Buffer<ArrayBufferLike>
  let fragData: Buffer[] = [];
  let fragging = false;
  return (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    let frames: WsFrame[];
    let rest: Buffer;
    try {
      ({ frames, rest } = decodeFrames(buf));
    } catch {
      // over-cap frame (DoS guard) or malformed framing → close loudly, drop buffer
      buf = Buffer.alloc(0);
      cb.onClose();
      return;
    }
    buf = rest;
    for (const f of frames) {
      // RFC 6455 §5.1: a server MUST fail the connection on an unmasked client frame.
      if (!f.masked) {
        cb.onClose();
        return;
      }
      switch (f.opcode) {
        case 0x8: // close
          cb.onClose();
          break;
        case 0x9: // ping
          cb.onPing(f.payload);
          break;
        case 0xa: // pong — ignore
          break;
        case 0x1: // text (possibly fragmented)
          fragData = [f.payload];
          fragging = true;
          if (f.fin) {
            cb.onText(Buffer.concat(fragData).toString("utf8"));
            fragData = [];
            fragging = false;
          }
          break;
        case 0x0: // continuation
          if (fragging) {
            fragData.push(f.payload);
            if (f.fin) {
              cb.onText(Buffer.concat(fragData).toString("utf8"));
              fragData = [];
              fragging = false;
            }
          }
          break;
        default:
          break; // unknown opcode — ignore
      }
    }
  };
}
