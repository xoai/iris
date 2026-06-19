// makeRestChannel (ADR-0009, Spec 05 B3): an in-process node:http server speaking
// the TWO-IDENTIFIER protocol. The channel MINTS the sessionId and OWNS/ISSUES the
// continuationToken — the client presents it on the next call. Every turn ROTATES
// the token; a missing/stale/malformed token is refused with a LOUD 4xx, never a
// silent 200 (no-silent-failures). In-process for the suite; a real external HTTP
// deploy is a manual smoke. Host-side (node:http + node:crypto); core stays pure.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { runTurnOn, type HostAdapter } from "@iris/host";
import type {
  Program,
  PerformerRegistry,
  LogicalClock,
  Json,
  JournalRecord,
  TurnOutcome,
} from "@iris/core";
import { type StreamEvent, toOutcomeEvent } from "./events.ts";
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

export interface RestChannelOptions<S extends Json> {
  adapter: HostAdapter;
  // Per-(session, request) turn inputs. Return PERSISTENT performers per session if
  // the program carries cross-turn performer state (e.g. a scripted model). MAY be
  // async (the channel awaits it) so a caller can resolve a held image pin per turn.
  // The 3rd arg `emit` is present ONLY on a streaming (SSE/WS) request — bind the
  // model performer's onDelta to it for live token deltas; undefined on the
  // buffered path (no deltas).
  makeTurnInputs: (
    sessionId: string,
    body: Json,
    emit?: (ev: StreamEvent) => void,
  ) => TurnInputs<S> | Promise<TurnInputs<S>>;
  mintSessionId?: () => string; // default: a random UUID
  mintToken?: () => string; // default: a random UUID (the channel owns this)
  // Optional PRE-POST GET hook (the web channel mounts here, ADR-0009 / spec §2.1).
  // It is consulted BEFORE the POST-only guard; it owns only GET asset routes and
  // MUST return false for anything it does not serve, so the `/v1/*` POST routes and
  // the WebSocket upgrade path (a separate `upgrade` listener) are untouched. When
  // undefined, the channel behaves byte-identically to before (purely additive).
  webHandler?: (req: IncomingMessage, res: ServerResponse) => boolean; // true = handled
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
  const mintSessionId = opts.mintSessionId ?? (() => randomUUID());
  const mintToken = opts.mintToken ?? (() => randomUUID());
  // The channel OWNS the current continuationToken per session (in-process here;
  // a real deploy would persist it). It rotates on every committed turn.
  const tokens = new Map<string, string>();
  // Sessions with a turn in flight — enforces the token's SINGLE-USE invariant
  // under concurrency (the token rotates only after the turn commits, so without
  // this a second concurrent request presenting the same valid token would slip
  // past the check before rotation; ADR-0009 advertises single-use, so we honor it).
  const inFlight = new Set<string>();

  // Rotate the continuationToken ONLY on a COMMITTED turn (single-use). A
  // `contended` turn journaled nothing — the lease was held elsewhere — so the
  // prior token stays valid and the client retries it (no rotation). A START turn
  // (priorToken === null) always issues a fresh token. Used by all three paths
  // (buffered/SSE/WS) so token discipline is identical across them.
  const issueToken = (
    sessionId: string,
    outcome: TurnOutcome<S>,
    priorToken: string | null,
  ): string => {
    if (priorToken !== null && outcome.status === "contended") return priorToken;
    const token = mintToken();
    tokens.set(sessionId, token);
    return token;
  };

  const runTurn = async (
    sessionId: string,
    body: Json,
    emit?: (ev: StreamEvent) => void,
  ): Promise<TurnOutcome<S>> => {
    const inputs = await opts.makeTurnInputs(sessionId, body, emit);
    // onRecord is the per-REQUEST journal-timeline tap (only on a streaming
    // request). It rides RunTurnOnOptions, NOT TurnInputs (per-session-static).
    const onRecord = emit
      ? (r: JournalRecord): void => emit({ type: "record", record: r as unknown as Json })
      : undefined;
    return runTurnOn(opts.adapter, {
      sessionId,
      ...inputs,
      ...(onRecord ? { onRecord } : {}),
    });
  };

  // Drive one turn into an SSE stream: records + deltas, then a terminal outcome
  // carrying the rotated token. Validation (loud 4xx) already ran in the handler
  // BEFORE this opens the stream, so a refusal is never a half-open SSE.
  const streamTurn = async (
    res: ServerResponse,
    sessionId: string,
    body: Json,
    priorToken: string | null, // null on START; the current token on CONTINUE
  ): Promise<void> => {
    const sse = openSse(res);
    const emit = (ev: StreamEvent): void => sse.emit(ev);
    let outcome: TurnOutcome<S>;
    try {
      outcome = await runTurn(sessionId, body, emit);
    } catch (err) {
      // The turn threw AFTER the stream opened — surface it in-band, loudly.
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      sse.end();
      return;
    }
    emit(toOutcomeEvent(sessionId, outcome, issueToken(sessionId, outcome, priorToken)));
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
      const sessionId = mintSessionId();
      if (stream) {
        await streamTurn(res, sessionId, body, null); // START → always issues a fresh token
        return;
      }
      const outcome = await runTurn(sessionId, body);
      const token = issueToken(sessionId, outcome, null);
      send(res, 200, turnResponse(sessionId, token, outcome));
      return;
    }

    // --- continue: REQUIRE the matching token, then ROTATE it -------------
    const m = SESSION_MESSAGE.exec(url);
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      if (!tokens.has(sessionId)) {
        send(res, 404, { error: `unknown session '${sessionId}'` });
        return;
      }
      const headerToken = req.headers["x-continuation-token"];
      const presented =
        typeof body.continuationToken === "string"
          ? body.continuationToken
          : typeof headerToken === "string"
            ? headerToken
            : null;
      if (presented === null || presented === "") {
        send(res, 400, { error: "missing continuationToken" });
        return;
      }
      if (presented !== tokens.get(sessionId)) {
        send(res, 409, { error: "stale or invalid continuationToken" });
        return;
      }
      // The token check above and this in-flight claim run in ONE event-loop
      // callback with no interleaving, so a SECOND concurrent request presenting
      // the same valid token is refused HERE — before the token rotates — instead
      // of slipping past the check. The flag also keeps the token usable across a
      // failed turn: we rotate ONLY on success, in the finally we just release.
      if (inFlight.has(sessionId)) {
        send(res, 409, { error: "a turn is already in flight for this session" });
        return;
      }
      inFlight.add(sessionId);
      try {
        if (stream) {
          await streamTurn(res, sessionId, body, presented); // CONTINUE → rotate only if committed
        } else {
          const outcome = await runTurn(sessionId, body);
          const next = issueToken(sessionId, outcome, presented);
          send(res, 200, turnResponse(sessionId, next, outcome));
        }
      } finally {
        inFlight.delete(sessionId);
      }
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
        sessionId = mintSessionId();
      } else if (presented !== null) {
        if (presented !== tokens.get(sessionId)) {
          sendEvent({ type: "error", message: "stale or invalid continuationToken" });
          return;
        }
      }

      if (inFlight.has(sessionId)) {
        sendEvent({ type: "error", message: "a turn is already in flight for this session" });
        return;
      }
      const priorToken = tokens.get(sessionId) ?? null; // null on this connection's START turn
      inFlight.add(sessionId);
      try {
        const outcome = await runTurn(sessionId, body, sendEvent);
        sendEvent(toOutcomeEvent(sessionId, outcome, issueToken(sessionId, outcome, priorToken)));
      } catch (err) {
        sendEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight.delete(sessionId);
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

  // WebSocket upgrade (ADR-0008 capability gate): a host that does not advertise
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
