// The channel-PORT conformance cases — the two-identifier protocol every Iris channel
// must uphold (mint sessionId + single-use continuation token, committed-only
// rotation, the loud refusal taxonomy). Returns cases; never imports a test runner.
import assert from "node:assert/strict";
import type { ConformanceCase, ChannelPortFixture, Refusal } from "./types.ts";

const ALLOWED_REFUSALS: ReadonlySet<Refusal> = new Set<Refusal>([
  "unknown-session",
  "missing-token",
  "stale-token",
  "in-flight",
]);

export function runChannelPortConformance(fx: ChannelPortFixture): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const P = `[channel-port:${fx.name}]`;
  const c = (name: string, fn: () => Promise<void>): void => {
    cases.push({ name: `${P} ${name}`, fn });
  };

  // ── the 8 base assertions ─────────────────────────────────────────────────

  c("START mints a session and issues a non-empty token", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      assert.ok(s.sessionId.length > 0, "a sessionId is minted");
      assert.ok(s.token.length > 0, "a continuationToken is issued");
    } finally {
      await ops.close();
    }
  });

  c("a COMMITTED continue rotates the token", async () => {
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

  c("a stale token is refused loudly and the token is preserved", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const bad = await ops.continueTurn(s.sessionId, `${s.token}-WRONG`);
      assert.ok(!bad.ok && bad.refusal === "stale-token", `stale token → loud refusal (got ${JSON.stringify(bad)})`);
      const good = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(good.ok, "the original token is still valid after a refused stale attempt");
    } finally {
      await ops.close();
    }
  });

  c("a missing token is refused loudly", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn(s.sessionId, null);
      assert.ok(!r.ok && r.refusal === "missing-token", `missing token → loud refusal (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  c("an unknown session is refused loudly", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn("no-such-session", s.token);
      assert.ok(!r.ok && r.refusal === "unknown-session", `unknown session → loud refusal (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  c("a CONTENDED turn KEEPS the prior token (committed-only rotation)", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      ops.setNext("contend");
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

  c("an ABORTED turn KEEPS the prior token (committed-only rotation)", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      ops.setNext("abort");
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

  c("the token is SINGLE-USE under concurrency (two same-token continues → one in-flight)", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const [a, b] = await Promise.all([
        ops.continueTurn(s.sessionId, s.token),
        ops.continueTurn(s.sessionId, s.token),
      ]);
      const oks = [a, b].filter((r) => r.ok).length;
      const refused = [a, b].filter((r) => !r.ok && (r.refusal === "in-flight" || r.refusal === "stale-token")).length;
      assert.equal(oks, 1, `exactly one concurrent same-token continue wins (got ${JSON.stringify([a, b])})`);
      assert.equal(refused, 1, `the other is refused (in-flight or stale) — single-use (got ${JSON.stringify([a, b])})`);
    } finally {
      await ops.close();
    }
  });

  // ── gap cases (M3 hardening) ──────────────────────────────────────────────

  c("G1 token replay — a consumed (prior-turn) token is dead", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r1 = await ops.continueTurn(s.sessionId, s.token); // commits, rotates t0 → t1
      assert.ok(r1.ok, "the first continue commits");
      const replay = await ops.continueTurn(s.sessionId, s.token); // present the spent t0 again
      assert.ok(!replay.ok && replay.refusal === "stale-token", `a replayed token → stale (got ${JSON.stringify(replay)})`);
    } finally {
      await ops.close();
    }
  });

  c("G2 cross-session token — a valid token from a DIFFERENT session is refused", async () => {
    const ops = await fx.create();
    try {
      const s1 = await ops.start();
      const s2 = await ops.start();
      const r = await ops.continueTurn(s1.sessionId, s2.token); // s2's live token on s1
      assert.ok(!r.ok && r.refusal === "stale-token", `a cross-session token → stale (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  c("G3 concurrency > 2 — four same-token continues, exactly one commits", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => ops.continueTurn(s.sessionId, s.token)),
      );
      const oks = results.filter((r) => r.ok).length;
      const refused = results.filter((r) => !r.ok && (r.refusal === "in-flight" || r.refusal === "stale-token")).length;
      assert.equal(oks, 1, `exactly one of four wins (got ${JSON.stringify(results)})`);
      assert.equal(refused, 3, `the other three are refused single-use (got ${JSON.stringify(results)})`);
    } finally {
      await ops.close();
    }
  });

  c("G4 an empty-string token is missing-token (distinct from null), not a crash", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn(s.sessionId, "");
      assert.ok(!r.ok && r.refusal === "missing-token", `"" → missing-token (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  c("G5 a garbage sessionId is unknown-session, never a throw", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const r = await ops.continueTurn("../../weird::id\n", s.token);
      assert.ok(!r.ok && r.refusal === "unknown-session", `garbage sessionId → unknown-session (got ${JSON.stringify(r)})`);
    } finally {
      await ops.close();
    }
  });

  c("G6 non-committed rotation chain — contended, contended, then finished rotates once", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      ops.setNext("contend");
      const r1 = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r1.ok && r1.status === "contended" && r1.token === s.token, `1st contended keeps token (got ${JSON.stringify(r1)})`);
      ops.setNext("contend");
      const r2 = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r2.ok && r2.status === "contended" && r2.token === s.token, `2nd contended keeps token (got ${JSON.stringify(r2)})`);
      const r3 = await ops.continueTurn(s.sessionId, s.token);
      assert.ok(r3.ok && r3.status !== "contended" && r3.token !== s.token, `the commit rotates exactly once (got ${JSON.stringify(r3)})`);
    } finally {
      await ops.close();
    }
  });

  c("G7 every refusal is within the four-value taxonomy (no invented reason)", async () => {
    const ops = await fx.create();
    try {
      const s = await ops.start();
      const refusals = [
        await ops.continueTurn(s.sessionId, null), // missing
        await ops.continueTurn(s.sessionId, `${s.token}-X`), // stale
        await ops.continueTurn("nope", s.token), // unknown
      ];
      for (const r of refusals) {
        assert.ok(!r.ok, `expected a refusal (got ${JSON.stringify(r)})`);
        if (!r.ok) assert.ok(ALLOWED_REFUSALS.has(r.refusal), `refusal "${r.refusal}" is outside the taxonomy`);
      }
    } finally {
      await ops.close();
    }
  });

  // ── opt-in: hold-connection (token:null) path ─────────────────────────────

  if (fx.holdConnection) {
    const hold = fx.holdConnection.bind(fx);

    c("H1 a held connection advances WITHOUT a token (the first advance is a START)", async () => {
      const ops = await hold();
      try {
        const { sessionId } = ops.open();
        const r = await ops.advance(sessionId);
        assert.ok(r.ok, "a connection-authorized advance runs without a presented token");
        assert.ok(r.token && r.token.length > 0, "the START issues a token");
      } finally {
        await ops.close();
      }
    });

    c("H2 a committed advance over a held connection issues/rotates the token", async () => {
      const ops = await hold();
      try {
        const { sessionId } = ops.open();
        const r1 = await ops.advance(sessionId);
        const r2 = await ops.advance(sessionId);
        assert.ok(r1.ok && r2.ok, "both advances run");
        assert.notEqual(r2.token, r1.token, "a committed advance rotates the token");
      } finally {
        await ops.close();
      }
    });

    c("H3 two concurrent advances on one held connection → one in-flight", async () => {
      const ops = await hold();
      try {
        const { sessionId } = ops.open();
        const [a, b] = await Promise.all([ops.advance(sessionId), ops.advance(sessionId)]);
        const oks = [a, b].filter((r) => r.ok).length;
        assert.equal(oks, 1, `exactly one concurrent advance commits (got ${JSON.stringify([a, b])})`);
      } finally {
        await ops.close();
      }
    });
  }

  return cases;
}
