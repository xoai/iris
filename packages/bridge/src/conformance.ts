// Bridge conformance — certifies a bridge speaks the Iris REST channel protocol
// correctly (token adoption/rotation, independent conversations, clean restart) and
// that a platform adapter is verify-first. Runner-agnostic: returns cases, never
// imports a test runner. Stays zero-dep via an in-package fake channel that mimics
// the two-identifier protocol — no @irisrun import needed.
import assert from "node:assert/strict";
import { makeBridgeSession, type BridgeSession } from "./session.ts";
import { makePlatformBridge, type PlatformAdapter } from "./platform.ts";

export interface ConformanceCase {
  name: string;
  fn: () => Promise<void>;
}

type TestFn = (name: string, fn: () => Promise<void> | void) => unknown;

export function register(cases: ConformanceCase[], testFn: TestFn): void {
  for (const c of cases) testFn(c.name, c.fn);
}

// An in-memory stand-in for the Iris REST channel's two-identifier protocol: START
// mints a session + token; CONTINUE validates the presented token (404 unknown /
// 400 missing / 409 stale), ROTATES it on a committed turn, and returns an
// incrementing {turn:n}. A bridge that adopts the rotated token advances turns; one
// that re-presents a stale token gets 409 → a thrown error → a failed case.
function makeFakeChannel(): { fetchImpl: typeof fetch; baseUrl: string } {
  const sessions = new Map<string, { token: string; turns: number }>();
  let nextSession = 0;
  let nextToken = 0;
  const json = (data: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => data }) as Response;

  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as { continuationToken?: string }) : {};
    if (url.endsWith("/v1/session")) {
      const sessionId = `sess-${nextSession++}`;
      const token = `tok-${nextToken++}`;
      sessions.set(sessionId, { token, turns: 0 });
      return json({ sessionId, continuationToken: token, status: "finished", output: { turn: 0 } });
    }
    const m = url.match(/\/v1\/session\/([^/]+)\/message$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return json({ error: "unknown-session" }, 404);
      if (body.continuationToken == null) return json({ error: "missing-token" }, 400);
      if (body.continuationToken !== s.token) return json({ error: "stale-token" }, 409);
      s.turns += 1;
      s.token = `tok-${nextToken++}`;
      return json({ sessionId: m[1], continuationToken: s.token, status: "finished", output: { turn: s.turns } });
    }
    return json({ error: "not-found" }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, baseUrl: "http://fake.channel" };
}

type SessionFactory = (opts: { baseUrl: string; fetchImpl?: typeof fetch }) => BridgeSession;

/** Certify the session/token discipline a bridge must uphold. */
export function runBridgeConformance(makeSession: SessionFactory = makeBridgeSession): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const c = (name: string, fn: () => Promise<void>): void => {
    cases.push({ name: `bridge: ${name}`, fn });
  };

  c("a two-turn conversation adopts + rotates the token (turns advance 0 → 1)", async () => {
    const ch = makeFakeChannel();
    const session = makeSession({ baseUrl: ch.baseUrl, fetchImpl: ch.fetchImpl });
    const r1 = await session.onMessage({ conversationId: "x", text: "hi" });
    assert.equal(r1.status, "finished");
    assert.deepEqual(r1.output, { turn: 0 });
    const r2 = await session.onMessage({ conversationId: "x", text: "again" });
    assert.deepEqual(r2.output, { turn: 1 }, "the second turn continued the SAME session (token adopted+rotated)");
  });

  c("two conversations map to independent sessions", async () => {
    const ch = makeFakeChannel();
    const session = makeSession({ baseUrl: ch.baseUrl, fetchImpl: ch.fetchImpl });
    const a1 = await session.onMessage({ conversationId: "A", text: "x" });
    const b1 = await session.onMessage({ conversationId: "B", text: "y" });
    const a2 = await session.onMessage({ conversationId: "A", text: "x" });
    assert.deepEqual(a1.output, { turn: 0 });
    assert.deepEqual(b1.output, { turn: 0 }, "B starts its own session");
    assert.deepEqual(a2.output, { turn: 1 }, "A continues independently of B");
  });

  c("a fresh session starts clean (turn 0)", async () => {
    const ch = makeFakeChannel();
    const session = makeSession({ baseUrl: ch.baseUrl, fetchImpl: ch.fetchImpl });
    const r = await session.onMessage({ conversationId: "C", text: "hi" });
    assert.deepEqual(r.output, { turn: 0 });
  });

  c("the channel refuses a stale token loudly (the discipline the bridge relies on)", async () => {
    const ch = makeFakeChannel();
    const session = makeSession({ baseUrl: ch.baseUrl, fetchImpl: ch.fetchImpl });
    await session.onMessage({ conversationId: "Z", text: "hi" }); // mints sess-0 with a token
    const res = await ch.fetchImpl(`${ch.baseUrl}/v1/session/sess-0/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuationToken: "tok-bogus", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 409, "a stale token must be refused loudly");
  });

  return cases;
}

/** Certify a platform adapter: verify accepts/rejects correctly, parse maps a valid
 *  inbound, and the harness is verify-first (a tampered request drives no turn). */
export function runAdapterConformance<Reply>(
  adapter: PlatformAdapter<Reply>,
  vectors: {
    valid: { headers: Record<string, string | undefined>; rawBody: string };
    tampered: { headers: Record<string, string | undefined>; rawBody: string };
    expect: { conversationId: string; text: string };
  },
): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const c = (name: string, fn: () => Promise<void>): void => {
    cases.push({ name: `adapter[${adapter.name}]: ${name}`, fn });
  };

  c("verify accepts a valid request", async () => {
    assert.equal(adapter.verify(vectors.valid.headers, vectors.valid.rawBody), true);
  });

  c("verify rejects a tampered request (loud false, never throws)", async () => {
    assert.equal(adapter.verify(vectors.tampered.headers, vectors.tampered.rawBody), false);
  });

  c("parse maps a valid inbound to a message intent", async () => {
    const p = adapter.parse(vectors.valid.rawBody);
    assert.equal(p.kind, "message");
    if (p.kind === "message") {
      assert.equal(p.conversationId, vectors.expect.conversationId);
      assert.equal(p.text, vectors.expect.text);
    }
  });

  c("verify-first: a tampered request is 401 and drives NO turn", async () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      throw new Error("must not fetch on an unverified request");
    }) as unknown as typeof fetch;
    const bridge = makePlatformBridge(adapter, { baseUrl: "http://unused", fetchImpl: spy });
    const r = await bridge.handle(vectors.tampered.headers, vectors.tampered.rawBody);
    assert.equal(r.status, 401);
    assert.equal(fetched, false, "an unverified request must never reach the channel");
  });

  return cases;
}
