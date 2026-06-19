// Phase A (P0 items 3+4) — @iris/client-sdk over the `iris serve` two-identifier
// protocol. Buffered start/send round-trip + token rotation; a stale token is a
// LOUD IrisError(409); send() with no session refuses loudly; a SECOND client built
// from a stored handle resumes the SAME session AGAINST THE SAME RUNNING CHANNEL
// (the channel owns the token in-memory; the store carries the journal — a fresh
// channel over the same store would 404, so we do NOT test that). Plus the pure
// helpers parseSseFrames / decideStartOrResume, and the loud ws-unsupported refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Program, JournalRecord } from "@iris/core";
import { makeRestChannel, type TurnInputs } from "@iris/channel-rest";
import type { HostAdapter } from "@iris/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import {
  IrisClient,
  IrisError,
  parseSseFrames,
  decideStartOrResume,
  type SessionHandle,
} from "@iris/client-sdk";

// A trivial finishing program: each turn folds a finish marker to bump a counter, so
// successive turns produce distinguishable output {turn: N} (channel-rest.test.ts).
type ChState = { turns: number };
const program: Program<ChState> = {
  initial: { turns: 0 },
  reducer(state: ChState, record: JournalRecord): ChState {
    if (record.kind === "marker" && (record.payload as { marker?: string }).marker === "finish") {
      return { turns: state.turns + 1 };
    }
    return state;
  },
  step(state: ChState) {
    return { type: "finish", output: { turn: state.turns } } as const;
  },
};

function makeChannel() {
  const adapter: HostAdapter = {
    name: "iris-serve-test",
    capabilities: { long_running: true },
    store: new MemStateStore(),
    scheduler: new MemScheduler(),
  };
  const makeTurnInputs = (): TurnInputs<ChState> => ({
    program,
    performers: {},
    clock: new TestClock(1),
    defDigest: "img-digest",
  });
  return makeRestChannel<ChState>({ adapter, makeTurnInputs });
}

// --- pure helpers ------------------------------------------------------------

test("parseSseFrames: a clean frame yields one event and empty rest", () => {
  const { events, rest } = parseSseFrames('event: delta\ndata: {"type":"delta","text":"hi"}\n\n');
  assert.deepEqual(events, [{ type: "delta", text: "hi" }]);
  assert.equal(rest, "");
});

test("parseSseFrames: coalesced frames yield multiple events in order", () => {
  const buf =
    'event: delta\ndata: {"type":"delta","text":"a"}\n\n' +
    'event: delta\ndata: {"type":"delta","text":"b"}\n\n';
  const { events, rest } = parseSseFrames(buf);
  assert.deepEqual(events, [
    { type: "delta", text: "a" },
    { type: "delta", text: "b" },
  ]);
  assert.equal(rest, "");
});

test("parseSseFrames: a trailing partial frame is retained in rest", () => {
  const buf = 'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"';
  const { events, rest } = parseSseFrames(buf);
  assert.deepEqual(events, [{ type: "delta", text: "a" }]);
  assert.equal(rest, 'data: {"type":"delta","text":"b"');
});

test("parseSseFrames: a frame split across two reads parses once joined", () => {
  const first = parseSseFrames('data: {"type":"delta"');
  assert.deepEqual(first.events, []);
  const second = parseSseFrames(first.rest + ',"text":"x"}\n\n');
  assert.deepEqual(second.events, [{ type: "delta", text: "x" }]);
  assert.equal(second.rest, "");
});

test("parseSseFrames: a malformed data frame surfaces a loud error event (not a silent skip)", () => {
  const buf = "event: delta\ndata: {not json}\n\n" + 'data: {"type":"delta","text":"ok"}\n\n';
  const { events, rest } = parseSseFrames(buf);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "error");
  assert.match((events[0] as { type: "error"; message: string }).message, /malformed/);
  assert.deepEqual(events[1], { type: "delta", text: "ok" });
  assert.equal(rest, "");
});

test("decideStartOrResume: null → start, a handle → resume", () => {
  assert.equal(decideStartOrResume(null), "start");
  assert.equal(decideStartOrResume({ sessionId: "s", continuationToken: "t" }), "resume");
});

// --- buffered round-trip + token discipline ----------------------------------

test("A2: start→send round-trips and the SDK adopts the rotated token", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const client = new IrisClient({ baseUrl: base });
    const r0 = await client.start({});
    assert.equal(r0.status, "finished");
    assert.deepEqual(r0.output, { turn: 0 });
    assert.equal(typeof client.handle?.sessionId, "string");
    const token0 = client.handle?.continuationToken;
    assert.equal(typeof token0, "string");

    const r1 = await client.send({});
    assert.equal(r1.status, "finished");
    assert.deepEqual(r1.output, { turn: 1 }, "the session advanced a turn");
    assert.notEqual(client.handle?.continuationToken, token0, "the SDK adopted the rotated token");
  } finally {
    await channel.close();
  }
});

test("A2: a stale continuationToken rejects with a LOUD IrisError(409)", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const client = new IrisClient({ baseUrl: base });
    await client.start({});
    const staleHandle = client.handle as SessionHandle;
    // advance once so the held token rotates and `staleHandle.continuationToken` is stale
    await client.send({});
    const stale = new IrisClient({ baseUrl: base, handle: staleHandle });
    await assert.rejects(
      () => stale.send({}),
      (e: unknown) => {
        assert.ok(e instanceof IrisError);
        assert.equal((e as IrisError).status, 409);
        return true;
      },
    );
  } finally {
    await channel.close();
  }
});

test("A2: send() before start() refuses loudly (no-session)", async () => {
  const client = new IrisClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.send({}),
    (e: unknown) => e instanceof IrisError && (e as IrisError).code === "no-session",
  );
});

// --- A3: resume against the SAME running channel instance --------------------

test("A3: a second client built from a stored handle resumes the SAME session", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const first = new IrisClient({ baseUrl: base });
    const r0 = await first.start({});
    assert.deepEqual(r0.output, { turn: 0 });
    const handle = first.handle as SessionHandle; // {sessionId, current token}

    // A FRESH client object, same running channel — continues the durable session.
    const resumed = new IrisClient({ baseUrl: base, handle });
    const r1 = await resumed.send({});
    assert.equal(r1.status, "finished");
    assert.deepEqual(r1.output, { turn: 1 }, "resumed client advanced the same session, no re-start");
    assert.equal(r1.sessionId, handle.sessionId, "same sessionId — not a new session");
  } finally {
    await channel.close();
  }
});

// --- WS reserved: loud refusal ----------------------------------------------

test("WS transport is refused loudly (ws-unsupported) until implemented", async () => {
  const client = new IrisClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.start({}, { stream: true, transport: "ws" }),
    (e: unknown) => e instanceof IrisError && (e as IrisError).code === "ws-unsupported",
  );
});
