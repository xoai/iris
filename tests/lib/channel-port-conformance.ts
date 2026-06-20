// Shared channel-PORT conformance suite (roadmap v0.2 §10, plan T10.2). The literal
// realization of the §10 done-when: "a documented channel-port spec with a conformance
// test ANY channel must pass." channel-rest and channel-mcp both run this exact set of
// behavioral assertions through their REAL transport surface; only the wire mapping
// (HTTP status / JSON-RPC code → refusal) comes from the fixture.
//
// Registration is SYNCHRONOUS (like model-provider-conformance.ts): the importing
// *.test.ts calls runChannelPortConformance() at module load, so node:test sees the
// tests during import. Each test calls fx.create() (a fresh channel) inside its async
// body — never wrap these in a deferred callback.
import { test } from "node:test";
import assert from "node:assert/strict";

export type Refusal = "unknown-session" | "missing-token" | "stale-token" | "in-flight";

export type ContinueOutcome =
  | { ok: true; token: string; status: string }
  | { ok: false; refusal: Refusal };

// A normalized driver over one channel transport. The fixture owns the wire mapping;
// `setNext` flips the underlying store for the NEXT continue so contended/aborted can
// be forced through the real transport.
export interface ChannelOps {
  start(): Promise<{ sessionId: string; token: string }>;
  setNext(mode: "ok" | "contend" | "abort"): void;
  continueTurn(sessionId: string, token: string | null): Promise<ContinueOutcome>;
  close(): Promise<void>;
}

export interface ChannelPortFixture {
  name: string;
  create(): Promise<ChannelOps>;
}

export function runChannelPortConformance(fx: ChannelPortFixture): void {
  const P = `[channel-port:${fx.name}]`;

  test(`${P} START mints a session and issues a non-empty token`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      assert.ok(s.sessionId.length > 0, "a sessionId is minted");
      assert.ok(s.token.length > 0, "a continuationToken is issued");
    } finally {
      await ops.close();
    }
  });

  test(`${P} a COMMITTED continue rotates the token`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r.ok, "the continue committed");
      if (r.ok) assert.notEqual(r.token, s.token, "a committed turn rotates the token");
    } finally {
      await ops.close();
    }
  });

  test(`${P} a stale token is refused loudly and the token is preserved`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const bad = await ops.continueTurn(s.sessionId, `${s.token}-WRONG`);
      assert.ok(!bad.ok && bad.refusal === "stale-token", `stale token → loud refusal (got ${JSON.stringify(bad)})`);
      // the real token still works (it was not rotated by the refusal)
      const good = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(good.ok, "the original token is still valid after a refused stale attempt");
    } finally {
      await ops.close();
    }
  });

  test(`${P} a missing token is refused loudly`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn(s.sessionId, null);
      assert.ok(!r.ok && r.refusal === "missing-token", `missing token → loud refusal (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  test(`${P} an unknown session is refused loudly`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn("no-such-session", s.token);
      assert.ok(!r.ok && r.refusal === "unknown-session", `unknown session → loud refusal (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  test(`${P} a CONTENDED turn KEEPS the prior token (§10 committed-only rotation)`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      ops.setNext("contend"); // the next turn loses the lease CAS → contended, nothing journaled
      const r = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r.ok, `contended is a normal outcome, not a refusal (got ${JSON.stringify(r)})`);
      if (r.ok) {
        assert.equal(r.status, "contended", "the turn was contended");
        assert.equal(r.token, s.token, "a contended turn must NOT rotate the token");
      }
    } finally {
      await ops.close();
    }
  });

  test(`${P} an ABORTED turn KEEPS the prior token (§10 committed-only rotation)`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      ops.setNext("abort"); // the next append fails stale_fence → LeaseLost → aborted
      const r = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r.ok, `aborted is a normal outcome, not a refusal (got ${JSON.stringify(r)})`);
      if (r.ok) {
        assert.equal(r.status, "aborted", "the turn was aborted");
        assert.equal(r.token, s.token, "an aborted turn must NOT rotate the token");
      }
    } finally {
      await ops.close();
    }
  });

  test(`${P} the token is SINGLE-USE under concurrency (two same-token continues → one in-flight)`, async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const [a, b] = await Promise.all([
        ops.continueTurn(s.sessionId, s.token),
        ops.continueTurn(s.sessionId, s.token),
      ]);
      const oks = [a, b].filter((r) => r.ok).length;
      // The loser is refused EITHER in-flight (caught before the winner rotated) OR
      // stale-token (the winner already rotated) — both prove the token is single-use
      // and was not double-applied; which one occurs depends only on scheduling.
      const refused = [a, b].filter((r) => !r.ok && (r.refusal === "in-flight" || r.refusal === "stale-token")).length;
      assert.equal(oks, 1, `exactly one concurrent same-token continue wins (got ${JSON.stringify([a, b])})`);
      assert.equal(refused, 1, `the other is refused (in-flight or stale) — single-use (got ${JSON.stringify([a, b])})`);
    } finally {
      await ops.close();
    }
  });
}
