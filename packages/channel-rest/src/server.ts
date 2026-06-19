// makeRestChannel (ADR-0009, Spec 05 B3): an in-process node:http server speaking
// the TWO-IDENTIFIER protocol. The channel MINTS the sessionId and OWNS/ISSUES the
// continuationToken — the client presents it on the next call. Every turn ROTATES
// the token; a missing/stale/malformed token is refused with a LOUD 4xx, never a
// silent 200 (no-silent-failures). In-process for the suite; a real external HTTP
// deploy is a manual smoke. Host-side (node:http + node:crypto); core stays pure.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runTurnOn, type HostAdapter } from "@iris/host";
import type { Program, PerformerRegistry, LogicalClock, Json, TurnOutcome } from "@iris/core";

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
  // the program carries cross-turn performer state (e.g. a scripted model).
  makeTurnInputs: (sessionId: string, body: Json) => TurnInputs<S>;
  mintSessionId?: () => string; // default: a random UUID
  mintToken?: () => string; // default: a random UUID (the channel owns this)
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

  const runTurn = async (sessionId: string, body: Json): Promise<TurnOutcome<S>> => {
    const inputs = opts.makeTurnInputs(sessionId, body);
    return runTurnOn(opts.adapter, { sessionId, ...inputs });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? "").split("?")[0];

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
      const outcome = await runTurn(sessionId, body);
      const token = mintToken();
      tokens.set(sessionId, token);
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
        const outcome = await runTurn(sessionId, body);
        const next = mintToken();
        tokens.set(sessionId, next); // rotate ONLY after a committed turn → single-use
        send(res, 200, turnResponse(sessionId, next, outcome));
      } finally {
        inFlight.delete(sessionId);
      }
      return;
    }

    send(res, 404, { error: `no route for ${url}` });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      // Never a silent 200: an internal failure surfaces as a loud 5xx.
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, 500, { error: `internal error: ${message}` });
      else res.end();
    });
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
