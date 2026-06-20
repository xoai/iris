// @irisrun/client-sdk — a thin, isomorphic client over the `iris serve` protocol
// (spec §1). The channel MINTS the sessionId and OWNS/ROTATES the single-use
// continuationToken; this client mirrors that discipline EXACTLY: it adopts the
// rotated token the server returns and presents it on the next turn. Zero runtime
// deps — only global `fetch` / `TextDecoder` / `ReadableStream` (Node ≥24 + browser).
// It defines its OWN local StreamEvent union (NOT imported from @irisrun/channel-rest,
// which pulls node:http and would break the browser build). No silent failures: a
// non-2xx, a mid-stream `error` event, or a transport failure all reject LOUDLY.
import type { Json } from "@irisrun/core";

export const PACKAGE = "@irisrun/client-sdk";

/** What a durable session is addressed by: the channel's id + the current token. */
export interface SessionHandle {
  sessionId: string;
  continuationToken: string;
}

export interface IrisClientOptions {
  /** e.g. "http://127.0.0.1:8787" (a trailing slash is trimmed). */
  baseUrl: string;
  /** injected for tests; default = globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** default = globalThis.WebSocket (WS is reserved — see SendOptions.transport). */
  WebSocketImpl?: typeof WebSocket;
  /** RESUME: bind to an existing session (same running serve channel owns the token). */
  handle?: SessionHandle;
}

/**
 * The SDK's OWN request type (NOT a @irisrun/core type). The server's `bodyToInput`
 * normalizes a missing/empty `messages`, so the SDK keeps it optional; `@irisrun/core`'s
 * `HarnessInput` requires it.
 */
export interface TurnInput {
  messages?: { role: string; content: string }[];
}

/** EXACTLY the server's TurnOutcome statuses (no client-invented values). */
export type TurnStatus = "finished" | "parked" | "contended" | "aborted";

/**
 * The wire event union — defined LOCALLY (pure data mirroring channel-rest/events.ts),
 * deliberately NOT imported from @irisrun/channel-rest (keeps the SDK node:-free).
 */
export type StreamEvent =
  | { type: "record"; record: Json }
  | { type: "delta"; text: string }
  | {
      type: "outcome";
      sessionId: string;
      status: TurnStatus;
      output?: Json;
      wait?: Json;
      current?: number;
      continuationToken?: string;
    }
  | { type: "error"; message: string };

export interface TurnResult {
  sessionId: string;
  continuationToken?: string;
  status: TurnStatus;
  output?: Json;
  wait?: Json;
  current?: number;
  /** the concatenation of streamed `delta`s (streaming turns only). */
  text?: string;
}

export interface StreamCallbacks {
  onRecord?(record: Json): void;
  onDelta?(text: string): void;
  /** a mid-stream `error` event (after the stream already opened). */
  onError?(message: string): void;
}

export interface SendOptions {
  stream?: boolean;
  /** "sse" (default when streaming) or "ws" (reserved — throws until implemented). */
  transport?: "sse" | "ws";
  callbacks?: StreamCallbacks;
}

/** A loud, structured error — never a silent resolve. */
export class IrisError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "IrisError";
    this.code = code;
    this.status = status;
  }
}

// --- pure, unit-testable helpers (no IO) -------------------------------------

/**
 * Parse complete SSE frames out of `buffer`, returning the parsed events and the
 * trailing PARTIAL frame (`rest`) to carry into the next read. Frames are separated
 * by a blank line (`\n\n`); each frame's `data:` line(s) carry the full StreamEvent
 * JSON (the `event:` line is redundant — the JSON has its own `type`). A frame whose
 * data is not valid JSON is skipped defensively (the server emits valid JSON).
 */
export function parseSseFrames(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  let rest = buffer;
  let sep = rest.indexOf("\n\n");
  while (sep !== -1) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data !== "") {
      try {
        events.push(JSON.parse(data) as StreamEvent);
      } catch {
        // Surface a corrupt frame LOUDLY (no silent skip) as an `error` event — the
        // consumer turns it into onError() + a rejected turn. The server only emits
        // valid JSON, so this is defensive (e.g. a proxy mangled the stream).
        events.push({ type: "error", message: `malformed SSE data frame: ${data.slice(0, 120)}` });
      }
    }
    sep = rest.indexOf("\n\n");
  }
  return { events, rest };
}

/** Decide whether a client with this stored handle should START fresh or RESUME. */
export function decideStartOrResume(handle: SessionHandle | null): "start" | "resume" {
  return handle === null ? "start" : "resume";
}

// --- the client --------------------------------------------------------------

export class IrisClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl?: typeof WebSocket;
  private session: SessionHandle | null;

  constructor(opts: IrisClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== "function") {
      throw new IrisError("no fetch implementation available (pass fetchImpl)", "no-fetch");
    }
    this.fetchImpl = f;
    this.WebSocketImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.session = opts.handle ?? null;
  }

  /** The current {sessionId, continuationToken}, or null before the first start. */
  get handle(): SessionHandle | null {
    return this.session;
  }

  /** START a new session — POST /v1/session. */
  async start(input: TurnInput = {}, opts: SendOptions = {}): Promise<TurnResult> {
    return this.turn(`${this.baseUrl}/v1/session`, input, null, opts);
  }

  /** CONTINUE the held session — POST /v1/session/<id>/message (presents the token).
   *  `async` so the no-session guard surfaces as a rejected promise, never a sync throw. */
  async send(input: TurnInput = {}, opts: SendOptions = {}): Promise<TurnResult> {
    if (this.session === null) {
      throw new IrisError(
        "send() with no session — call start() first or construct the client with a handle",
        "no-session",
      );
    }
    const url = `${this.baseUrl}/v1/session/${encodeURIComponent(this.session.sessionId)}/message`;
    return this.turn(url, input, this.session.continuationToken, opts);
  }

  // Adopt the (possibly rotated) token. The server always issues one on a committed
  // turn; on `contended` it returns the UNCHANGED prior token. Keep the prior token
  // if the server omitted one (defensive — mirrors toOutcomeEvent's optional token).
  private adopt(sessionId: string, token: string | undefined): void {
    const continuationToken = token ?? this.session?.continuationToken;
    this.session = continuationToken === undefined ? null : { sessionId, continuationToken };
  }

  private async turn(
    url: string,
    input: TurnInput,
    token: string | null,
    opts: SendOptions,
  ): Promise<TurnResult> {
    if (opts.transport === "ws") {
      // The serve WS server is connection-scoped (a fresh connection can only START;
      // continuation needs the SAME held connection). A correct client is a
      // held-connection model — reserved. Refuse LOUDLY rather than fake it. The
      // edge/web paths are SSE-only anyway (edge declares websockets:false).
      throw new IrisError(
        "ws transport is not yet implemented in client-sdk; use SSE (stream:true). The edge/web paths are SSE-only.",
        "ws-unsupported",
      );
    }
    const body: Record<string, Json> = { ...(input as Record<string, Json>) };
    if (token !== null) body.continuationToken = token;
    return opts.stream ? this.sseTurn(url, body, opts) : this.bufferedTurn(url, body);
  }

  private async bufferedTurn(url: string, body: Record<string, Json>): Promise<TurnResult> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.httpError(res);
    const data = (await res.json()) as {
      sessionId: string;
      continuationToken?: string;
      status: TurnStatus;
      output?: Json;
      wait?: Json;
      current?: number;
    };
    this.adopt(data.sessionId, data.continuationToken);
    return {
      sessionId: data.sessionId,
      continuationToken: data.continuationToken,
      status: data.status,
      output: data.output,
      wait: data.wait,
      current: data.current,
    };
  }

  private async sseTurn(
    url: string,
    body: Record<string, Json>,
    opts: SendOptions,
  ): Promise<TurnResult> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    // A loud-4xx refusal (stale/missing token, in-flight) is a JSON error BEFORE the
    // stream opens — surface it the same as a buffered error.
    if (!res.ok) throw await this.httpError(res);
    if (res.body === null) throw new IrisError("streaming response had no body", "no-body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deltas: string[] = [];
    let outcome: Extract<StreamEvent, { type: "outcome" }> | null = null;
    let streamError: string | null = null;

    const consume = (events: StreamEvent[]): void => {
      for (const ev of events) {
        if (ev.type === "delta") {
          deltas.push(ev.text);
          opts.callbacks?.onDelta?.(ev.text);
        } else if (ev.type === "record") {
          opts.callbacks?.onRecord?.(ev.record);
        } else if (ev.type === "error") {
          streamError = ev.message;
          opts.callbacks?.onError?.(ev.message);
        } else {
          outcome = ev;
        }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      consume(parsed.events);
      if (done) break;
    }

    if (outcome === null) {
      // The channel emits `error` then ends WITHOUT an outcome on a post-open throw.
      throw new IrisError(
        streamError ?? "stream ended without an outcome",
        streamError !== null ? "stream-error" : "no-outcome",
      );
    }
    const oc = outcome as Extract<StreamEvent, { type: "outcome" }>;
    this.adopt(oc.sessionId, oc.continuationToken);
    return {
      sessionId: oc.sessionId,
      continuationToken: oc.continuationToken,
      status: oc.status,
      output: oc.output,
      wait: oc.wait,
      current: oc.current,
      text: deltas.join(""),
    };
  }

  private async httpError(res: Response): Promise<IrisError> {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (j !== null && typeof j.error === "string") message = j.error;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    return new IrisError(message, "http-error", res.status);
  }
}
