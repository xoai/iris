// makeChannelSession — the transport-agnostic driver behind every
// Iris channel. It owns the two-identifier protocol in ONE place: mint the sessionId,
// own + rotate a single-use continuationToken, an atomic per-session in-flight claim,
// and the loud refusal taxonomy. channel-rest, channel-mcp, and channel-slack all
// drive it; a shared conformance suite (@irisrun/channel-conformance) pins
// the contract so a new channel is replay-safe by construction.
//
// TOKEN ROTATION:
// rotate the token ONLY on a COMMITTED outcome (`finished`/`parked`); a NON-committed
// outcome (`contended` = lease held elsewhere; `aborted` = lease lost mid-flight)
// journaled nothing, so it KEEPS the prior token (the single-use credential was not
// consumed — the client retries with it). A START always issues a fresh token.
import type { Json, TurnOutcome } from "@irisrun/core";
import type { ChannelEvent } from "./events.ts";

/** Why a continue was refused — each maps to a transport's loud error. */
export type ChannelRefusal = "unknown-session" | "missing-token" | "stale-token" | "in-flight";

export interface StartResult<S extends Json> {
  sessionId: string;
  token: string;
  outcome: TurnOutcome<S>;
}
export type ContinueResult<S extends Json> =
  | { ok: true; sessionId: string; token: string; outcome: TurnOutcome<S> }
  | { ok: false; reason: ChannelRefusal };
/** advance() result: in-flight is the only refusal it can produce (validation is separate). */
export type AdvanceResult<S extends Json> =
  | { ok: true; sessionId: string; token: string; outcome: TurnOutcome<S> }
  | { ok: false; reason: "in-flight" };

export interface ChannelSessionOptions<S extends Json> {
  // Run one turn. The transport supplies this (it wires the host adapter, performers,
  // program, etc.). `emit` is present only on a streaming request — undefined buffered.
  runTurn: (sessionId: string, body: Json, emit?: (ev: ChannelEvent) => void) => Promise<TurnOutcome<S>>;
  mintSessionId?: () => string;
  mintToken?: () => string;
}

export interface ChannelSession<S extends Json> {
  /** START: mint a session, run the first turn, issue a fresh token. */
  start(body: Json, emit?: (ev: ChannelEvent) => void): Promise<StartResult<S>>;
  /** CONTINUE (strict): validate the token, claim in-flight, run, rotate. */
  continueTurn(
    sessionId: string,
    presentedToken: string | null,
    body: Json,
    emit?: (ev: ChannelEvent) => void,
  ): Promise<ContinueResult<S>>;
  /** Pure token validation (no run) — for streaming transports that must refuse
   *  loudly BEFORE opening the stream. Returns null when the token is acceptable.
   *  Does NOT consider in-flight (use inFlight()); call inFlight() then advance() with
   *  no `await` in between to keep the check→claim atomic. */
  validateContinue(sessionId: string, presentedToken: string | null): ChannelRefusal | null;
  /** True if a turn is already in flight for this session (peek; for streaming). */
  inFlight(sessionId: string): boolean;
  /** Claim in-flight, run the turn, rotate per the committed-only rule, release.
   *  Used by START, by continueTurn, and directly by the WS path (which authorizes via
   *  the held connection rather than a presented token). A fresh session id (not yet
   *  registered) runs as a START (prior token null → always mints). */
  advance(sessionId: string, body: Json, emit?: (ev: ChannelEvent) => void): Promise<AdvanceResult<S>>;
  /** A fresh session id (for the WS path, which binds the session to the connection
   *  synchronously before the first turn runs). */
  newSessionId(): string;
  currentToken(sessionId: string): string | undefined;
  hasSession(sessionId: string): boolean;
}

function randomId(): string {
  // node:crypto is host-side; avoid importing it here so channel-core stays
  // dependency-light. A transport may inject mintSessionId/mintToken (they do, with
  // randomUUID) — this fallback is only for tests/usages that don't.
  return `${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`;
}

const COMMITTED = new Set(["finished", "parked"]);

export function makeChannelSession<S extends Json>(opts: ChannelSessionOptions<S>): ChannelSession<S> {
  const mintSessionId = opts.mintSessionId ?? randomId;
  const mintToken = opts.mintToken ?? randomId;
  // The channel OWNS the current continuationToken per session (in-process; a durable
  // deploy persists the durable JOURNAL in the store — the token is an instance-local
  // ordering credential, not durable state).
  const tokens = new Map<string, string>();
  // Single-use guard under concurrency: the in-flight claim is taken in the SAME
  // event-loop callback as the token check, with no `await` between, so a second
  // concurrent request presenting the same valid token is refused before rotation.
  const inFlightSet = new Set<string>();

  // Issue the next token: rotate (mint) ONLY on a committed outcome; a non-committed
  // outcome with a prior token keeps it. A START (priorToken null) always mints.
  const issueToken = (sessionId: string, outcome: TurnOutcome<S>, priorToken: string | null): string => {
    if (priorToken !== null && !COMMITTED.has(outcome.status)) return priorToken;
    const token = mintToken();
    tokens.set(sessionId, token);
    return token;
  };

  const advance = async (
    sessionId: string,
    body: Json,
    emit?: (ev: ChannelEvent) => void,
  ): Promise<AdvanceResult<S>> => {
    if (inFlightSet.has(sessionId)) return { ok: false, reason: "in-flight" };
    const prior = tokens.get(sessionId) ?? null; // null for a fresh session → START
    inFlightSet.add(sessionId);
    try {
      const outcome = await opts.runTurn(sessionId, body, emit);
      const token = issueToken(sessionId, outcome, prior);
      return { ok: true, sessionId, token, outcome };
    } finally {
      inFlightSet.delete(sessionId);
    }
  };

  const validateContinue = (sessionId: string, presentedToken: string | null): ChannelRefusal | null => {
    if (!tokens.has(sessionId)) return "unknown-session";
    if (presentedToken === null || presentedToken === "") return "missing-token";
    if (presentedToken !== tokens.get(sessionId)) return "stale-token";
    return null;
  };

  return {
    async start(body, emit) {
      const sessionId = mintSessionId();
      // A brand-new id cannot be in flight, so advance always succeeds here.
      const r = await advance(sessionId, body, emit);
      // r.ok is always true (fresh id). Narrow for the type system.
      if (!r.ok) throw new Error("channel-core: unreachable in-flight on a fresh session");
      return { sessionId, token: r.token, outcome: r.outcome };
    },

    async continueTurn(sessionId, presentedToken, body, emit) {
      // Token check (sync) → advance (claims in-flight synchronously before its first
      // await) — one callback, no await between → the single-use claim is atomic.
      const refusal = validateContinue(sessionId, presentedToken);
      if (refusal) return { ok: false, reason: refusal };
      return advance(sessionId, body, emit);
    },

    validateContinue,
    inFlight: (sessionId) => inFlightSet.has(sessionId),
    advance,
    newSessionId: () => mintSessionId(),
    currentToken: (sessionId) => tokens.get(sessionId),
    hasSession: (sessionId) => tokens.has(sessionId),
  };
}
