// The OpenAI SSE reader decodes with a STREAMING TextDecoder, so a multibyte UTF-8
// rune split across two network chunks reassembles intact — never corrupted to
// U+FFFD. (Iris memory: mid-stream UTF-8 cuts must respect rune boundaries.) Mirror
// of anthropic-sse-utf8.test.ts for @irisrun/provider-openai.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOpenAiSse } from "@irisrun/provider-openai";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

test("readOpenAiSse: a multibyte rune split across chunks reassembles (no U+FFFD)", async () => {
  const text = "世界🌍café"; // 3-byte CJK, 4-byte emoji, 2-byte accented — mixed widths
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(sse);

  // Split at the FIRST UTF-8 CONTINUATION byte (0b10xxxxxx) — it sits inside the
  // first multibyte rune of the content (the SSE prefix is all ASCII), so the cut
  // bisects a rune across the chunk boundary. (The multibyte text is in the first
  // frame, so a whole-SSE midpoint would land in the ASCII tail.)
  let cut = 0;
  while (cut < bytes.length && (bytes[cut] & 0xc0) !== 0x80) cut++;
  assert.ok(cut < bytes.length && (bytes[cut] & 0xc0) === 0x80, "test setup: found a mid-rune split point");

  const deltas: string[] = [];
  const acc = await readOpenAiSse(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), (t) =>
    deltas.push(t),
  );

  assert.equal(acc.content, text, "content reassembled across the chunk boundary");
  assert.equal(deltas.join(""), text, "deltas reassemble to the full text");
  assert.equal(acc.stopReason, "stop");
  assert.ok(!acc.content.includes("�"), "no replacement character");
});
