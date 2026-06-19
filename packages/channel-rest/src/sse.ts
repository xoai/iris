// SSE transport helpers (serve-streaming Task 4). `wantsStream` decides whether a
// request asked for a stream (Accept: text/event-stream, or ?stream=1). `openSse`
// writes the SSE head and returns a GUARDED emitter — a write on a closed/destroyed
// socket must never throw into the engine (the turn already commits durably; a
// disconnect just stops further writes). Host-side (node:http).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamEvent } from "./events.ts";

export function wantsStream(req: IncomingMessage, rawUrl: string): boolean {
  const accept = req.headers["accept"];
  if (typeof accept === "string" && accept.includes("text/event-stream")) return true;
  const q = rawUrl.split("?")[1] ?? "";
  return /(^|&)stream=1(&|$)/.test(q);
}

export interface SseWriter {
  emit(ev: StreamEvent): void;
  end(): void;
  closed(): boolean;
}

export function openSse(res: ServerResponse): SseWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  return {
    emit(ev: StreamEvent): void {
      if (closed) return;
      try {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch {
        closed = true; // socket gone — stop writing, never throw
      }
    },
    end(): void {
      if (closed) return;
      closed = true;
      try {
        res.end();
      } catch {
        /* already gone */
      }
    },
    closed(): boolean {
      return closed;
    },
  };
}
