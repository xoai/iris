// Certifies the channel-core driver itself against @irisrun/channel-conformance via a
// synthetic fixture — and, crucially, supplies the opt-in `holdConnection` so the
// token:null advance path (the WebSocket/gRPC shape REST/MCP can't reach) is exercised.
// Plus a teeth meta-test: a channel that never rotates the token must FAIL the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeChannelSession } from "@irisrun/channel-core";
import type { Json, TurnOutcome } from "@irisrun/core";
import {
  runChannelPortConformance,
  register,
  type ChannelOps,
  type HoldConnectionOps,
} from "@irisrun/channel-conformance";

const finished = (): TurnOutcome<Json> => ({ status: "finished", output: {} }) as unknown as TurnOutcome<Json>;
const outcomeFor = (m: "ok" | "contend" | "abort"): TurnOutcome<Json> => {
  if (m === "contend") return { status: "contended", current: 5 } as unknown as TurnOutcome<Json>;
  if (m === "abort") return { status: "aborted", reason: "lease_lost" } as unknown as TurnOutcome<Json>;
  return finished();
};

// Token-based ops over the core driver (a fresh session per case).
function makeCoreOps(): ChannelOps {
  let next: "ok" | "contend" | "abort" = "ok";
  let s = 0;
  let t = 0;
  const session = makeChannelSession<Json>({
    runTurn: async () => {
      const m = next;
      next = "ok";
      return outcomeFor(m);
    },
    mintSessionId: () => `cs-${s++}`,
    mintToken: () => `ct-${t++}`,
  });
  return {
    async start() {
      const r = await session.start({});
      return { sessionId: r.sessionId, token: r.token };
    },
    setNext: (m) => {
      next = m;
    },
    async continueTurn(sessionId, token) {
      const r = await session.continueTurn(sessionId, token, {});
      if (r.ok) return { ok: true, token: r.token, status: r.outcome.status };
      return { ok: false, refusal: r.reason };
    },
    close: async () => {},
  };
}

// The connection-authorized (token:null) path: bind a session to a connection
// (newSessionId), then advance() with no presented token.
function makeHoldConnectionOps(): HoldConnectionOps {
  let s = 0;
  let t = 0;
  const session = makeChannelSession<Json>({
    runTurn: async () => finished(),
    mintSessionId: () => `cs-${s++}`,
    mintToken: () => `ct-${t++}`,
  });
  return {
    open() {
      return { sessionId: session.newSessionId() };
    },
    async advance(sessionId) {
      const r = await session.advance(sessionId, {});
      if (r.ok) return { ok: true, token: r.token, status: r.outcome.status };
      return { ok: false };
    },
    close: async () => {},
  };
}

register(
  runChannelPortConformance({
    name: "channel-core (synthetic)",
    create: async () => makeCoreOps(),
    holdConnection: async () => makeHoldConnectionOps(),
  }),
  test,
);

// ── teeth: a contract-violating channel must fail the suite ───────────────────

// A channel that NEVER rotates the token (returns the same token on a committed turn).
function brokenNoRotateOps(): ChannelOps {
  const token = "fixed-token";
  let n = 0;
  const sessions = new Set<string>();
  return {
    async start() {
      const id = `bs-${n++}`;
      sessions.add(id);
      return { sessionId: id, token };
    },
    setNext: () => {},
    async continueTurn(sessionId, t) {
      if (!sessions.has(sessionId)) return { ok: false, refusal: "unknown-session" };
      if (t === null || t === "") return { ok: false, refusal: "missing-token" };
      if (t !== token) return { ok: false, refusal: "stale-token" };
      return { ok: true, token, status: "finished" }; // never rotates — WRONG
    },
    close: async () => {},
  };
}

test("teeth: the suite FAILS a channel that never rotates its token", async () => {
  const cases = runChannelPortConformance({ name: "broken", create: async () => brokenNoRotateOps() });
  let failures = 0;
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failures += 1;
    }
  }
  assert.ok(failures > 0, "a channel that never rotates the token must fail at least one conformance case");
});
