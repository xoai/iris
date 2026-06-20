// serve-streaming Task 3 (AS-3): the SSE reader decodes with a STREAMING
// TextDecoder, so a multibyte UTF-8 rune split across two network chunks
// reassembles intact — never corrupted to U+FFFD. (Iris memory: mid-stream UTF-8
// cuts must respect rune boundaries.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAnthropicSse } from "@irisrun/provider-anthropic";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

test("readAnthropicSse: a multibyte rune split across chunks reassembles (no U+FFFD)", async () => {
  const text = "世界🌍café"; // 3-byte CJK, 4-byte emoji, 2-byte accented — mixed widths
  const sse =
    `event: content_block_delta\n` +
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const bytes = new TextEncoder().encode(sse);

  // split at a byte that is a UTF-8 CONTINUATION byte (0b10xxxxxx) → bisects a rune
  let cut = Math.floor(bytes.length / 2);
  while (cut < bytes.length && (bytes[cut] & 0xc0) !== 0x80) cut++;
  assert.ok(cut < bytes.length && (bytes[cut] & 0xc0) === 0x80, "test setup: found a mid-rune split point");

  const deltas: string[] = [];
  const acc = await readAnthropicSse(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), (t) =>
    deltas.push(t),
  );

  assert.equal(acc.content, text, "content reassembled across the chunk boundary");
  assert.equal(deltas.join(""), text, "deltas reassemble to the full text");
  assert.ok(!acc.content.includes("�"), "no replacement character");
});
