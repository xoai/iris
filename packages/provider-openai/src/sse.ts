// OpenAI Chat Completions SSE reader. Consumes the `text/event-stream` body of a
// streaming `/v1/chat/completions` response, fires `onDelta` per content delta, and
// accumulates the SAME logical result the buffered path produces (text joined +
// finish_reason + usage). Host-side; zero deps (Web-standard ReadableStream /
// TextDecoder). Mirrors @iris/provider-anthropic/src/sse.ts.
//
// Rune safety: a multibyte UTF-8 character can be split across network chunks. We
// decode with a STREAMING TextDecoder so a half-rune at a chunk boundary is held
// until its tail arrives — never emitted as U+FFFD. (See the Iris memory lesson on
// mid-stream UTF-8 cuts.)

export interface OpenAiStreamAccumulator {
  content: string; // content deltas joined — reconciles with the buffered result
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Read an OpenAI Chat Completions SSE stream to completion. `onDelta` receives each
 * content delta exactly once, in order; the returned accumulator is the reconciled
 * result. A malformed `data:` line is skipped (never thrown) — one bad frame must
 * not crash a turn. The `data: [DONE]` sentinel terminates the stream.
 */
export async function readOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<OpenAiStreamAccumulator> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  let stopReason = "stop";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let done = false;

  const handleBlock = (block: string): void => {
    // An SSE event is a set of lines; per the spec, multiple `data:` lines in one
    // event join with "\n" (each stripped of a single leading space). OpenAI emits
    // single-line data frames, so this is spec-correctness insurance.
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data += (data === "" ? "" : "\n") + line.slice(5).replace(/^ /, "");
    }
    if (data === "") return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let obj: SseChunk;
    try {
      obj = JSON.parse(data) as SseChunk;
    } catch {
      return; // malformed frame → skip, never throw
    }
    const choice = obj.choices?.[0];
    if (choice) {
      if (typeof choice.delta?.content === "string" && choice.delta.content !== "") {
        content += choice.delta.content;
        onDelta(choice.delta.content);
      }
      if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
    }
    // Usage arrives in a trailing chunk (choices:[]) when stream_options.include_usage.
    if (obj.usage) {
      if (typeof obj.usage.prompt_tokens === "number") inputTokens = obj.usage.prompt_tokens;
      if (typeof obj.usage.completion_tokens === "number") outputTokens = obj.usage.completion_tokens;
    }
  };

  const drainBuffer = (): void => {
    buf = buf.replace(/\r\n/g, "\n"); // normalize CRLF → LF (data JSON has no raw newline)
    let idx: number;
    while (!done && (idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleBlock(block);
    }
  };

  try {
    while (!done) {
      const { value, done: rdDone } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      drainBuffer();
      if (rdDone) {
        buf += decoder.decode(); // flush any pending bytes
        buf = buf.replace(/\r\n/g, "\n");
        if (!done && buf.trim() !== "") handleBlock(buf); // trailing event with no blank line
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const acc: OpenAiStreamAccumulator = { content, stopReason };
  if (inputTokens !== undefined || outputTokens !== undefined) {
    acc.usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  }
  return acc;
}
