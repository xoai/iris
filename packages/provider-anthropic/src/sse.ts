// Anthropic Messages SSE reader (serve-streaming Task 3). Consumes the
// `text/event-stream` body of a streaming `/v1/messages` response, fires `onDelta`
// per text delta, and accumulates the SAME logical result the buffered path
// produces (text joined + stop_reason + usage). Host-side; zero deps (Web-standard
// ReadableStream / TextDecoder).
//
// Rune safety: a multibyte UTF-8 character can be split across network chunks. We
// decode with a STREAMING TextDecoder so a half-rune at a chunk boundary is held
// until its tail arrives — never emitted as U+FFFD. (See the Iris memory lesson on
// mid-stream UTF-8 cuts.)

export interface AnthropicStreamAccumulator {
  content: string; // text deltas joined — reconciles with the buffered result
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface SseEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Read an Anthropic SSE stream to completion. `onDelta` receives each text delta
 * exactly once, in order; the returned accumulator is the reconciled result. A
 * malformed `data:` line is skipped (never thrown) — one bad frame must not crash
 * a turn; unknown event types are ignored (forward-compat).
 */
export async function readAnthropicSse(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<AnthropicStreamAccumulator> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  let stopReason = "end_turn";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let done = false;

  const handleBlock = (block: string): void => {
    // An SSE event is a set of lines; we route on the `data:` JSON's own `type`,
    // not the decorative `event:` line.
    let data = "";
    for (const line of block.split("\n")) {
      // Per the SSE spec, multiple `data:` lines in one event join with "\n"
      // (each stripped of a single leading space). Anthropic emits single-line
      // data frames, so this is spec-correctness insurance, not a hot path.
      if (line.startsWith("data:")) data += (data === "" ? "" : "\n") + line.slice(5).replace(/^ /, "");
    }
    if (data === "") return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let obj: SseEvent;
    try {
      obj = JSON.parse(data) as SseEvent;
    } catch {
      return; // malformed frame → skip, never throw
    }
    switch (obj.type) {
      case "content_block_delta":
        if (obj.delta?.type === "text_delta" && typeof obj.delta.text === "string") {
          content += obj.delta.text;
          onDelta(obj.delta.text);
        }
        break;
      case "message_start": {
        const u = obj.message?.usage;
        if (u) {
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
        }
        break;
      }
      case "message_delta":
        if (typeof obj.delta?.stop_reason === "string") stopReason = obj.delta.stop_reason;
        if (typeof obj.usage?.output_tokens === "number") outputTokens = obj.usage.output_tokens;
        break;
      case "message_stop":
        done = true;
        break;
      default:
        break; // ignore unknown event types
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

  const acc: AnthropicStreamAccumulator = { content, stopReason };
  if (inputTokens !== undefined || outputTokens !== undefined) {
    acc.usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  }
  return acc;
}
