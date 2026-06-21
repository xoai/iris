// makeRestChannel: an in-process node:http server speaking
// the TWO-IDENTIFIER protocol. The channel MINTS the sessionId and OWNS/ISSUES the
// continuationToken — the client presents it on the next call. Every turn ROTATES
// the token; a missing/stale/malformed token is refused with a LOUD 4xx, never a
// silent 200 (no-silent-failures). In-process for the suite; a real external HTTP
// deploy is a manual smoke. Host-side (node:http + node:crypto); core stays pure.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { runTurnOn, type HostAdapter } from "@irisrun/host";
import type {
  Program,
  PerformerRegistry,
  LogicalClock,
  Json,
  JournalRecord,
  TurnOutcome,
} from "@irisrun/core";
import { type StreamEvent, toOutcomeEvent } from "./events.ts";
import { makeChannelSession, type ChannelRefusal } from "@irisrun/channel-core";
import { wantsStream, openSse } from "./sse.ts";
import {
  writeHandshake,
  refuseUpgrade,
  makeWsFramer,
  encodeTextFrame,
  encodeCloseFrame,
  encodePongFrame,
} from "./ws.ts";

export interface TurnInputs<S extends Json> {
  program: Program<S>;
  performers: PerformerRegistry;
  clock: LogicalClock;
  defDigest: string;
  snapshotThreshold?: number;
  holderId?: string;
}

/** The per-(session,request) turn-inputs builder a channel drives. `emit` is present
 *  ONLY on a streaming (SSE/WS) request. Exported as a named alias so adapter authors
 *  (via @irisrun/sdk) can type their own builder. */
export type MakeTurnInputs<S extends Json> = (
  sessionId: string,
  body: Json,
  emit?: (ev: StreamEvent) => void,
) => TurnInputs<S> | Promise<TurnInputs<S>>;

/** A pre-POST GET hook (the web channel mounts here); returns true if it served the
 *  request — the inline type RestChannelOptions.webHandler has always used. */
export type WebHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface RestChannelOptions<S extends Json> {
  adapter: HostAdapter;
  // Per-(session, request) turn inputs. Return PERSISTENT performers per session if
  // the program carries cross-turn performer state (e.g. a scripted model). MAY be
  // async (the channel awaits it) so a caller can resolve a held image pin per turn.
  // The 3rd arg `emit` is present ONLY on a streaming (SSE/WS) request — bind the
  // model performer's onDelta to it for live token deltas; undefined on the
  // buffered path (no deltas).
  makeTurnInputs: MakeTurnInputs<S>;
  mintSessionId?: () => string; // default: a random UUID
  mintToken?: () => string; // default: a random UUID (the channel owns this)
  // Optional PRE-POST GET hook (the web channel mounts here).
  // It is consulted BEFORE the POST-only guard; it owns only GET asset routes and
  // MUST return false for anything it does not serve, so the `/v1/*` POST routes and
  // the WebSocket upgrade path (a separate `upgrade` listener) are untouched. When
  // undefined, the channel behaves byte-identically to before (purely additive).
  webHandler?: WebHandler; // true = handled
}

export interface RestChannel {
  server: Server;
  listen(port?: number, host?: string): Promise<string>; // binds host (default loopback); resolves to a connect URL
  close(): Promise<void>;
}

const SESSION_MESSAGE = /^\/v1\/session\/([^/]+)\/message$/;

function send(res: ServerResponse, status: number, body: Json): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: Json } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return { ok: true, body: {} }; // an empty body is the empty object
  try {
    return { ok: true, body: JSON.parse(raw) as Json };
  } catch {
    return { ok: false }; // malformed JSON → loud 4xx upstream
  }
}

function turnResponse<S extends Json>(
  sessionId: string,
  token: string,
  outcome: TurnOutcome<S>,
): Json {
  const base: Record<string, Json> = { sessionId, continuationToken: token, status: outcome.status };
  if (outcome.status === "finished" && outcome.output !== undefined) base.output = outcome.output;
  if (outcome.status === "parked") base.wait = outcome.wait as unknown as Json;
  if (outcome.status === "contended") base.current = outcome.current;
  return base;
}

export function makeRestChannel<S extends Json>(opts: RestChannelOptions<S>): RestChannel {
  // The two-identifier protocol (mint sessionId, own/rotate a single-use token, atomic
  // single-use, committed-only rotation) lives in the shared channel-core port — the
  // SAME driver channel-mcp uses. This REST transport maps refusals to HTTP status and
  // adds the SSE/WS framing. `runTurn` builds the per-request journal-timeline tap.
  const session = makeChannelSession<S>({
    runTurn: async (sessionId, body, emit) => {
      const inputs = await opts.makeTurnInputs(sessionId, body, emit as ((ev: StreamEvent) => void) | undefined);
      // onRecord is the per-REQUEST journal-timeline tap (only on a streaming request).
      // It rides RunTurnOnOptions, NOT TurnInputs (per-session-static).
      const onRecord = emit
        ? (r: JournalRecord): void => emit({ type: "record", record: r as unknown as Json })
        : undefined;
      return runTurnOn(opts.adapter, {
        sessionId,
        ...inputs,
        ...(onRecord ? { onRecord } : {}),
      });
    },
    mintSessionId: opts.mintSessionId ?? (() => randomUUID()),
    mintToken: opts.mintToken ?? (() => randomUUID()),
  });

  // Map a channel-core refusal to its LOUD HTTP status (preserving the prior messages).
  const REFUSAL_STATUS: Record<ChannelRefusal, number> = {
    "unknown-session": 404,
    "missing-token": 400,
    "stale-token": 409,
    "in-flight": 409,
  };
  const refusalMessage = (reason: ChannelRefusal, sessionId: string): string => {
    switch (reason) {
      case "unknown-session":
        return `unknown session '${sessionId}'`;
      case "missing-token":
        return "missing continuationToken";
      case "stale-token":
        return "stale or invalid continuationToken";
      case "in-flight":
        return "a turn is already in flight for this session";
    }
  };

  // Drive a session op into an SSE stream: records + deltas, then a terminal outcome
  // carrying the rotated token. Any loud refusal (4xx) already ran in the handler
  // BEFORE this opens the stream, so a refusal is never a half-open SSE.
  const runSse = async (
    res: ServerResponse,
    produce: (emit: (ev: StreamEvent) => void) => Promise<{ sessionId: string; token: string; outcome: TurnOutcome<S> }>,
  ): Promise<void> => {
    const sse = openSse(res);
    const emit = (ev: StreamEvent): void => sse.emit(ev);
    try {
      const r = await produce(emit);
      emit(toOutcomeEvent(r.sessionId, r.outcome, r.token));
    } catch (err) {
      // The turn threw AFTER the stream opened — surface it in-band, loudly.
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    sse.end();
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? "";
    const url = rawUrl.split("?")[0];
    const stream = wantsStream(req, rawUrl);

    // The optional web channel claims its GET routes BEFORE the POST-only guard.
    // It returns false for non-asset paths, so `/v1/*` POST falls through unchanged.
    if (opts.webHandler && opts.webHandler(req, res)) return;

    if (req.method !== "POST") {
      send(res, 405, { error: `method ${req.method} not allowed` });
      return;
    }

    const parsed = await readBody(req);
    if (!parsed.ok) {
      send(res, 400, { error: "malformed JSON body" });
      return;
    }
    const body = parsed.body as Record<string, Json>;

    // --- start: MINT a session + the first continuationToken --------------
    if (url === "/v1/session") {
      if (stream) {
        await runSse(res, async (emit) => {
          const r = await session.start(body, emit); // START → always issues a fresh token
          return { sessionId: r.sessionId, token: r.token, outcome: r.outcome };
        });
        return;
      }
      const r = await session.start(body);
      send(res, 200, turnResponse(r.sessionId, r.token, r.outcome));
      return;
    }

    // --- continue: REQUIRE the matching token, then ROTATE it -------------
    const m = SESSION_MESSAGE.exec(url);
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      const headerToken = req.headers["x-continuation-token"];
      const presented =
        typeof body.continuationToken === "string"
          ? body.continuationToken
          : typeof headerToken === "string"
            ? headerToken
            : null;
      if (stream) {
        // Validate the token AND peek in-flight BEFORE opening the stream — these
        // checks plus the advance() claim run with no `await` between, so the
        // single-use claim stays atomic and a refusal is never a half-open SSE.
        const refusal = session.validateContinue(sessionId, presented);
        if (refusal) {
          send(res, REFUSAL_STATUS[refusal], { error: refusalMessage(refusal, sessionId) });
          return;
        }
        if (session.inFlight(sessionId)) {
          send(res, 409, { error: "a turn is already in flight for this session" });
          return;
        }
        await runSse(res, async (emit) => {
          const r = await session.advance(sessionId, body, emit); // rotate only if committed
          if (!r.ok) throw new Error("a turn is already in flight for this session");
          return { sessionId, token: r.token, outcome: r.outcome };
        });
        return;
      }
      const r = await session.continueTurn(sessionId, presented, body);
      if (!r.ok) {
        send(res, REFUSAL_STATUS[r.reason], { error: refusalMessage(r.reason, sessionId) });
        return;
      }
      send(res, 200, turnResponse(sessionId, r.token, r.outcome));
      return;
    }

    send(res, 404, { error: `no route for ${url}` });
  };

  // A held WS connection drives the SAME two-identifier protocol over frames: the
  // first frame with no token STARTS (mints a session); a frame with a token
  // CONTINUES the connection's bound session. The token is read FRESH from the
  // shared Map each turn (never cached), so it stays coherent with the REST/SSE
  // paths' single-use rotation. (Cross-protocol concurrent driving of one session
  // is unsupported but still SAFE — the shared inFlight Set prevents double commit.)
  const runWsConnection = (socket: Duplex, head: Buffer): void => {
    let sessionId: string | null = null;
    const sendEvent = (ev: StreamEvent): void => {
      try {
        socket.write(encodeTextFrame(JSON.stringify(ev)));
      } catch {
        /* socket gone */
      }
    };

    const handleMessage = async (text: string): Promise<void> => {
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        sendEvent({ type: "error", message: "malformed JSON frame" });
        return;
      }
      const presented =
        typeof (body as Record<string, Json>).continuationToken === "string"
          ? ((body as Record<string, Json>).continuationToken as string)
          : null;

      if (sessionId === null) {
        if (presented !== null) {
          // a fresh connection can only START (no token); continuation needs a
          // session this connection already minted.
          sendEvent({ type: "error", message: "present no continuationToken to start a session" });
          return;
        }
        // Bind the session to the connection SYNCHRONOUSLY (before the first turn
        // runs) so a second frame on this connection sees the bound session.
        sessionId = session.newSessionId();
      } else if (presented !== null) {
        // The held connection authorizes continuation; a presented token (if any) is
        // validated against the current one (read fresh, never cached).
        if (presented !== session.currentToken(sessionId)) {
          sendEvent({ type: "error", message: "stale or invalid continuationToken" });
          return;
        }
      }

      // in-flight peek then advance() claim run with no `await` between → atomic
      // single-use even across two frames interleaving at their awaits.
      if (session.inFlight(sessionId)) {
        sendEvent({ type: "error", message: "a turn is already in flight for this session" });
        return;
      }
      try {
        // advance on a freshly-minted (unregistered) session runs as a START (prior
        // token null → mints); on a bound session it rotates per the committed rule.
        const r = await session.advance(sessionId, body, sendEvent);
        if (!r.ok) {
          sendEvent({ type: "error", message: "a turn is already in flight for this session" });
          return;
        }
        sendEvent(toOutcomeEvent(sessionId, r.outcome, r.token));
      } catch (err) {
        sendEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    };

    const feed = makeWsFramer({
      onText: (t) => {
        void handleMessage(t);
      },
      onPing: (p) => {
        try {
          socket.write(encodePongFrame(p));
        } catch {
          /* gone */
        }
      },
      onClose: () => {
        try {
          socket.write(encodeCloseFrame());
        } catch {
          /* gone */
        }
        socket.end();
      },
    });

    if (head && head.length > 0) feed(head);
    socket.on("data", (chunk: Buffer) => feed(chunk));
    socket.on("error", () => {
      /* a dropped connection is not a server error */
    });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      // Never a silent 200: an internal failure surfaces as a loud 5xx.
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, 500, { error: `internal error: ${message}` });
      else res.end();
    });
  });

  // WebSocket upgrade (capability gate): a host that does not advertise
  // `websockets` is refused LOUDLY (426, no 101) — never silently downgraded.
  server.on("upgrade", (req, socket, head) => {
    if (opts.adapter.capabilities.websockets !== true) {
      refuseUpgrade(socket, "426 Upgrade Required");
      return;
    }
    if ((req.url ?? "").split("?")[0] !== "/v1/ws") {
      refuseUpgrade(socket, "404 Not Found");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers["upgrade"] ?? "").toLowerCase();
    if (upgrade !== "websocket" || typeof key !== "string") {
      refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    writeHandshake(socket, key);
    runWsConnection(socket, head);
  });

  return {
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<string> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const p = typeof addr === "object" && addr ? addr.port : port;
          // a wildcard bind (0.0.0.0/::) is reachable externally; the returned URL
          // uses loopback so a local client can always connect.
          const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
          resolve(`http://${connectHost}:${p}`);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
