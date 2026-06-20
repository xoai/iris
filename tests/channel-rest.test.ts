// T4 (M-Proof) — the REST channel's TWO-IDENTIFIER protocol (ADR-0009). The channel
// MINTS the sessionId and ISSUES the continuationToken; a follow-up message must
// present the issued token (round-trip: issue → present-on-next) and gets a NEW
// token back. A missing / stale / malformed token — or a message to an unknown
// session — is refused with a LOUD 4xx, never a silent 200. A minimal finishing
// program keeps the test focused on the protocol, not on harness re-entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Program, Json, JournalRecord } from "@irisrun/core";
import { FsStateStore, FsScheduler } from "@irisrun/store-fs";
import { makeRestChannel, type TurnInputs } from "@irisrun/channel-rest";
import type { HostAdapter } from "@irisrun/host";
import { TestClock } from "./lib/mem-store.ts";

type ChState = { turns: number };

// A trivial, effect-free program: each turn finishes, folding the finish marker to
// bump a turn counter — so successive turns produce distinguishable output.
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
  const root = mkdtempSync(join(tmpdir(), "iris-rest-"));
  const adapter: HostAdapter = {
    name: "serverless-fs",
    capabilities: { long_running: false, filesystem: true },
    store: new FsStateStore({ root }),
    scheduler: new FsScheduler({ root }),
  };
  const makeTurnInputs = (): TurnInputs<ChState> => ({
    program,
    performers: {}, // no effects
    clock: new TestClock(1),
    defDigest: "img-digest",
  });
  return makeRestChannel<ChState>({ adapter, makeTurnInputs });
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test("T4: start ISSUES {sessionId, continuationToken}; a follow-up with the issued token round-trips a NEW token", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    // start MINTS the session + the first token
    const start = await postJson(`${base}/v1/session`, {});
    assert.equal(start.status, 200);
    assert.equal(typeof start.json.sessionId, "string");
    assert.equal(typeof start.json.continuationToken, "string");
    assert.equal(start.json.status, "finished");
    assert.deepEqual(start.json.output, { turn: 0 });

    const sessionId = start.json.sessionId as string;
    const token1 = start.json.continuationToken as string;

    // continue: present the ISSUED token → success + a NEW token (issue → present-on-next)
    const cont = await postJson(`${base}/v1/session/${sessionId}/message`, { continuationToken: token1 });
    assert.equal(cont.status, 200);
    assert.equal(cont.json.status, "finished");
    assert.deepEqual(cont.json.output, { turn: 1 }, "the session advanced a turn");
    const token2 = cont.json.continuationToken as string;
    assert.equal(typeof token2, "string");
    assert.notEqual(token2, token1, "the channel rotated the continuationToken");
  } finally {
    await channel.close();
  }
});

test("T4: a STALE token is a loud 409 (the old token is single-use)", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const start = await postJson(`${base}/v1/session`, {});
    const sessionId = start.json.sessionId as string;
    const token1 = start.json.continuationToken as string;
    // burn token1 (rotates to token2)
    await postJson(`${base}/v1/session/${sessionId}/message`, { continuationToken: token1 });
    // re-presenting the now-stale token1 must be refused
    const stale = await postJson(`${base}/v1/session/${sessionId}/message`, { continuationToken: token1 });
    assert.equal(stale.status, 409);
    assert.match(String(stale.json.error), /stale|invalid/i);
  } finally {
    await channel.close();
  }
});

test("T4: a MISSING token is a loud 400", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const start = await postJson(`${base}/v1/session`, {});
    const sessionId = start.json.sessionId as string;
    const missing = await postJson(`${base}/v1/session/${sessionId}/message`, {});
    assert.equal(missing.status, 400);
    assert.match(String(missing.json.error), /missing continuationToken/i);
  } finally {
    await channel.close();
  }
});

test("T4: a message to an UNKNOWN session is a loud 404", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const res = await postJson(`${base}/v1/session/does-not-exist/message`, { continuationToken: "x" });
    assert.equal(res.status, 404);
    assert.match(String(res.json.error), /unknown session/i);
  } finally {
    await channel.close();
  }
});

test("T4: a malformed JSON body is a loud 400 (never a silent 200)", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const res = await fetch(`${base}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error?: string };
    assert.match(String(json.error), /malformed JSON/i);
  } finally {
    await channel.close();
  }
});

test("T4: the continuationToken is SINGLE-USE under concurrency — two same-token requests do not both win", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const start = await postJson(`${base}/v1/session`, {});
    const sessionId = start.json.sessionId as string;
    const token1 = start.json.continuationToken as string;
    // fire TWO concurrent /message calls presenting the SAME valid token
    const [a, b] = await Promise.all([
      postJson(`${base}/v1/session/${sessionId}/message`, { continuationToken: token1 }),
      postJson(`${base}/v1/session/${sessionId}/message`, { continuationToken: token1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    // exactly one succeeds (200); the other is refused (409) — never two 200s
    assert.deepEqual(statuses, [200, 409], `single-use violated: got ${JSON.stringify(statuses)}`);
  } finally {
    await channel.close();
  }
});

test("T4: the continuationToken may also be presented via the x-continuation-token header", async () => {
  const channel = makeChannel();
  const base = await channel.listen();
  try {
    const start = await postJson(`${base}/v1/session`, {});
    const sessionId = start.json.sessionId as string;
    const token1 = start.json.continuationToken as string;
    const res = await fetch(`${base}/v1/session/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-continuation-token": token1 },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
  } finally {
    await channel.close();
  }
});
