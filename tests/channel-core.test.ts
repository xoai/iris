// makeChannelSession unit pins. runTurn is injected
// directly here, so the token-rotation rule and the refusal taxonomy are tested in
// isolation — including the §10 correction: a non-committed outcome (contended/aborted)
// KEEPS the prior token, a committed outcome (finished/parked) rotates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, TurnOutcome } from "@irisrun/core";
import { makeChannelSession } from "@irisrun/channel-core";

type Status = "finished" | "parked" | "contended" | "aborted";

// A minimal TurnOutcome — the session reads only `.status` for rotation. Cast at the
// boundary (the full shape is the engine's; this exercises the rotation logic).
function outcome(status: Status): TurnOutcome<Json> {
  const o: Record<string, Json> = { status };
  if (status === "finished") o.output = { ok: true };
  if (status === "parked") o.wait = { kind: "signal", name: "x" };
  if (status === "contended") o.current = 5;
  if (status === "aborted") o.reason = "lease_lost";
  return o as unknown as TurnOutcome<Json>;
}

// Deterministic mints so token rotation is observable.
function makeSession(nextStatus: () => Status) {
  let s = 0;
  let t = 0;
  return makeChannelSession<Json>({
    runTurn: async () => outcome(nextStatus()),
    mintSessionId: () => `sess-${s++}`,
    mintToken: () => `tok-${t++}`,
  });
}

test("channel-core: START mints a session and issues the first token", async () => {
  const session = makeSession(() => "finished");
  const r = await session.start({});
  assert.equal(r.sessionId, "sess-0");
  assert.equal(r.token, "tok-0");
  assert.equal(session.currentToken("sess-0"), "tok-0");
  assert.ok(session.hasSession("sess-0"));
});

test("channel-core: a COMMITTED continue (finished) rotates the token", async () => {
  const session = makeSession(() => "finished");
  const { sessionId, token } = await session.start({});
  const r = await session.continueTurn(sessionId, token, {});
  assert.ok(r.ok);
  if (r.ok) {
    assert.notEqual(r.token, token, "finished must rotate the token");
    assert.equal(session.currentToken(sessionId), r.token);
  }
});

test("channel-core: a COMMITTED continue (parked) also rotates", async () => {
  const statuses: Status[] = ["finished", "parked"];
  let i = 0;
  const session = makeSession(() => statuses[i++] ?? "finished");
  const { sessionId, token } = await session.start({}); // finished
  const r = await session.continueTurn(sessionId, token, {}); // parked
  assert.ok(r.ok);
  if (r.ok) assert.notEqual(r.token, token, "parked is committed → rotate");
});

test("channel-core: a CONTENDED continue KEEPS the prior token (the §10 correction)", async () => {
  const statuses: Status[] = ["finished", "contended"];
  let i = 0;
  const session = makeSession(() => statuses[i++] ?? "finished");
  const { sessionId, token } = await session.start({});
  const r = await session.continueTurn(sessionId, token, {});
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.token, token, "contended journaled nothing → token must NOT rotate");
    assert.equal(session.currentToken(sessionId), token, "the stored token is unchanged");
  }
});

test("channel-core: an ABORTED continue KEEPS the prior token (the §10 correction)", async () => {
  const statuses: Status[] = ["finished", "aborted"];
  let i = 0;
  const session = makeSession(() => statuses[i++] ?? "finished");
  const { sessionId, token } = await session.start({});
  const r = await session.continueTurn(sessionId, token, {});
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.token, token, "aborted journaled nothing → token must NOT rotate");
});

test("channel-core: refusal taxonomy — unknown-session / missing-token / stale-token", async () => {
  const session = makeSession(() => "finished");
  const { sessionId, token } = await session.start({});

  const unknown = await session.continueTurn("no-such-session", token, {});
  assert.deepEqual(unknown, { ok: false, reason: "unknown-session" });

  const missing = await session.continueTurn(sessionId, null, {});
  assert.deepEqual(missing, { ok: false, reason: "missing-token" });

  const empty = await session.continueTurn(sessionId, "", {});
  assert.deepEqual(empty, { ok: false, reason: "missing-token" }, "empty string is missing");

  const stale = await session.continueTurn(sessionId, "tok-wrong", {});
  assert.deepEqual(stale, { ok: false, reason: "stale-token" });

  // a refused continue must NOT have rotated the token
  assert.equal(session.currentToken(sessionId), token);
});

test("channel-core: a concurrent continue with the SAME token is refused in-flight (atomic single-use)", async () => {
  // The gate holds a turn open ONLY while it is active, so START resolves immediately
  // and the FIRST continue stays in flight when the second arrives.
  let gateOn = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let t = 0;
  const session = makeChannelSession<Json>({
    runTurn: async () => {
      if (gateOn) await gate; // hold the in-flight turn open
      return outcome("finished");
    },
    mintSessionId: () => "s",
    mintToken: () => `tok-${t++}`,
  });
  const { sessionId, token } = await session.start({}); // gateOn false → resolves now
  gateOn = true;
  // fire two continues with the SAME token, NO await between → first claims in-flight
  // (then awaits the gate); second sees the claim and is refused before any await.
  const p1 = session.continueTurn(sessionId, token, {});
  const p2 = session.continueTurn(sessionId, token, {});
  release(); // let the first turn finish
  const [a, b] = await Promise.all([p1, p2]);
  const oks = [a, b].filter((r) => r.ok).length;
  const inflight = [a, b].filter((r) => !r.ok && r.reason === "in-flight").length;
  assert.equal(oks, 1, "exactly one concurrent continue commits");
  assert.equal(inflight, 1, "the other is refused in-flight (single-use)");
});
