// serve-streaming Task 5 (AS-5): the hand-rolled zero-dep WebSocket. Two layers:
// (1) the frame codec in isolation — masking, partial buffering, fragmentation,
// the 64-bit length branch, ping/close; (2) end-to-end via Node 24's BUILT-IN
// WebSocket client — handshake, a streamed turn (records/deltas/outcome), token
// rotation, and the ADR-0008 capability-gate refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import type { Performer, Json } from "@irisrun/core";
import {
  makeRestChannel,
  type StreamEvent,
  decodeFrames,
  encodeTextFrame,
  encodePongFrame,
  encodeCloseFrame,
  makeWsFramer,
} from "@irisrun/channel-rest";
import type { HostAdapter } from "@irisrun/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";

const REPLY = "hello there world";
const bundle = defaultBundle();

function streamingModel(reply: string, onDelta?: (t: string) => void): Performer {
  return async () => {
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i++) onDelta?.(i === 0 ? words[i] : ` ${words[i]}`);
    return { ok: true, value: { role: "assistant", content: reply, stopReason: "end_turn" } as unknown as Json };
  };
}

function wsChannel(websockets: boolean) {
  const store = new MemStateStore();
  const adapter: HostAdapter = {
    name: "ws-test",
    capabilities: { long_running: true, ...(websockets ? { websockets: true } : {}) },
    store,
    scheduler: new MemScheduler(),
  };
  return makeRestChannel({
    adapter,
    makeTurnInputs: (_sid: string, _body: Json, emit?: (ev: StreamEvent) => void) => {
      const onDelta = emit ? (t: string) => emit({ type: "delta", text: t }) : undefined;
      return {
        program: harnessProgram({ messages: [{ role: "user", content: "hi" }] }),
        performers: { tactic: bundle.tacticPerformer, model_call: streamingModel(REPLY, onDelta) },
        clock: new TestClock(1),
        defDigest: "img",
      };
    },
  });
}

// --- build a MASKED client frame (clients MUST mask) -------------------------
function clientFrame(text: string, opcode = 0x1, fin = true, force64 = false): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const b0 = (fin ? 0x80 : 0) | opcode;
  let header: Buffer;
  if (force64) {
    header = Buffer.allocUnsafe(10);
    header[0] = b0;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  } else if (len < 126) {
    header = Buffer.from([b0, 0x80 | len]);
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = b0;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

async function waitFor(pred: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

// =============================== codec unit tests ============================

test("ws codec: a server text frame round-trips through decodeFrames", () => {
  const { frames, rest } = decodeFrames(encodeTextFrame("héllo 世界"));
  assert.equal(rest.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x1);
  assert.equal(frames[0].payload.toString("utf8"), "héllo 世界");
});

test("ws codec: makeWsFramer unmasks a client text frame and reassembles across a partial delivery", () => {
  const got: string[] = [];
  const feed = makeWsFramer({ onText: (t) => got.push(t), onPing: () => {}, onClose: () => {} });
  const frame = clientFrame("hello");
  feed(frame.subarray(0, 4)); // half a frame — nothing yet
  assert.deepEqual(got, []);
  feed(frame.subarray(4)); // the rest → one message
  assert.deepEqual(got, ["hello"]);
});

test("ws codec: a FRAGMENTED text message (fin=0 text + fin=1 continuation) reassembles", () => {
  const got: string[] = [];
  const feed = makeWsFramer({ onText: (t) => got.push(t), onPing: () => {}, onClose: () => {} });
  feed(clientFrame("ab", 0x1, /*fin*/ false));
  feed(clientFrame("cd", 0x0, /*fin*/ true));
  assert.deepEqual(got, ["abcd"]);
});

test("ws codec: the 64-bit length branch decodes", () => {
  const got: string[] = [];
  const feed = makeWsFramer({ onText: (t) => got.push(t), onPing: () => {}, onClose: () => {} });
  feed(clientFrame("payload", 0x1, true, /*force64*/ true));
  assert.deepEqual(got, ["payload"]);
});

test("ws codec: an over-cap frame declaration closes the connection (DoS guard)", () => {
  let closed = false;
  let texts = 0;
  const feed = makeWsFramer({ onText: () => texts++, onPing: () => {}, onClose: () => (closed = true) });
  // a masked text-frame header declaring a 1 GiB 64-bit length, no payload sent
  const header = Buffer.allocUnsafe(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 2);
  Buffer.from([1, 2, 3, 4]).copy(header, 10);
  feed(header);
  assert.equal(closed, true, "an over-cap frame must close the connection, not buffer it");
  assert.equal(texts, 0);
});

test("ws codec: an UNMASKED client frame is rejected (RFC 6455 §5.1)", () => {
  let closed = false;
  let texts = 0;
  const feed = makeWsFramer({ onText: () => texts++, onPing: () => {}, onClose: () => (closed = true) });
  feed(encodeTextFrame("hi")); // a server-style (unmasked) frame from a client → protocol error
  assert.equal(texts, 0);
  assert.equal(closed, true);
});

test("ws codec: ping → onPing(payload); close → onClose", () => {
  let pinged: Buffer | null = null;
  let closed = false;
  const feed = makeWsFramer({
    onText: () => {},
    onPing: (p) => (pinged = p),
    onClose: () => (closed = true),
  });
  feed(clientFrame("pong-me", 0x9));
  feed(clientFrame("", 0x8));
  assert.ok(pinged !== null && (pinged as Buffer).toString("utf8") === "pong-me");
  assert.equal(closed, true);
  // and the server's pong/close encoders produce valid control frames
  assert.equal(encodePongFrame(Buffer.from("x"))[0], 0x8a);
  assert.equal(encodeCloseFrame()[0], 0x88);
});

// =========================== client integration =============================

test("WS: handshake + a streamed turn (records/deltas/outcome) + token rotation", async () => {
  const channel = wsChannel(true);
  const base = await channel.listen();
  const wsUrl = `${base.replace(/^http/, "ws")}/v1/ws`;
  const ws = new WebSocket(wsUrl);
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse((e as MessageEvent).data as string)));
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connection error")));
    });

    ws.send(JSON.stringify({})); // START
    await waitFor(() => frames.some((f) => f.type === "outcome"));
    const oc = frames.find((f) => f.type === "outcome")!;
    assert.equal(oc.status, "finished");
    assert.ok(frames.some((f) => f.type === "record"), "record frames streamed");
    assert.equal(
      frames.filter((f) => f.type === "delta").map((f) => f.text as string).join(""),
      REPLY,
      "deltas reconcile to the reply",
    );
    assert.equal(typeof oc.continuationToken, "string");

    frames.length = 0;
    ws.send(JSON.stringify({ continuationToken: oc.continuationToken })); // CONTINUE
    await waitFor(() => frames.some((f) => f.type === "outcome"));
    const oc2 = frames.find((f) => f.type === "outcome")!;
    assert.equal(oc2.status, "finished");
    assert.notEqual(oc2.continuationToken, oc.continuationToken, "the token rotated for the next turn");
  } finally {
    ws.close();
    await channel.close();
  }
});

test("WS: a host WITHOUT the websockets capability refuses the upgrade (no open)", async () => {
  const channel = wsChannel(false); // websockets capability absent
  const base = await channel.listen();
  const wsUrl = `${base.replace(/^http/, "ws")}/v1/ws`;
  const ws = new WebSocket(wsUrl);
  try {
    const result = await new Promise<string>((resolve) => {
      ws.addEventListener("open", () => resolve("open"));
      ws.addEventListener("error", () => resolve("error"));
      ws.addEventListener("close", () => resolve("close"));
    });
    assert.notEqual(result, "open", "the upgrade must be refused (426) without the websockets capability");
  } finally {
    try {
      ws.close();
    } catch {
      /* never opened */
    }
    await channel.close();
  }
});
