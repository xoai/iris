// serve-streaming Task 4 (AS-4): SSE over the channel-rest server. A streaming
// request gets the FULL committed-record timeline (tactic + model_call + marker)
// as `record` events, live model `delta` events, and a terminal `outcome` event
// carrying the rotated continuationToken — while the two-identifier protocol's
// loud-4xx guards (stale/missing token, in-flight) still fire as JSON BEFORE any
// stream opens. The buffered path is unchanged (see channel-rest.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import type { Performer, Json, Program, Version, CasResult } from "@irisrun/core";
import { makeRestChannel, type StreamEvent } from "@irisrun/channel-rest";
import type { HostAdapter } from "@irisrun/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";

// A store that can be told to fail the NEXT lease-key CAS once — deterministically
// forcing a `contended` turn (the lease was "held elsewhere").
class ContendableStore extends MemStateStore {
  contendNext = false;
  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    if (this.contendNext && key.startsWith("lease:")) {
      this.contendNext = false;
      return { ok: false, current: 999 };
    }
    return super.cas(key, expected, next);
  }
}

const REPLY = "hello there world";

// An authored STREAMING fake model: fires onDelta per word, returns the joined
// reply as the (journaled) result. onDelta is closed over — it is NOT a Performer
// argument. (Task 4 owns this fixture; no Task-6 echo perf is referenced.)
function streamingModel(reply: string, onDelta?: (t: string) => void): Performer {
  return async () => {
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i++) onDelta?.(i === 0 ? words[i] : ` ${words[i]}`);
    return { ok: true, value: { role: "assistant", content: reply, stopReason: "end_turn" } as unknown as Json };
  };
}

function bodyToInput(body: Json): { messages: { role: string; content: string }[] } {
  const b = body as { messages?: { role: string; content: string }[] };
  return Array.isArray(b.messages) && b.messages.length
    ? { messages: b.messages }
    : { messages: [{ role: "user", content: "hi" }] };
}

const bundle = defaultBundle();

function streamChannel(mintSessionId?: () => string) {
  const store = new MemStateStore();
  const adapter: HostAdapter = {
    name: "iris-serve-test",
    capabilities: { long_running: true },
    store,
    scheduler: new MemScheduler(),
  };
  const channel = makeRestChannel({
    adapter,
    ...(mintSessionId ? { mintSessionId } : {}),
    makeTurnInputs: (_sid: string, body: Json, emit?: (ev: StreamEvent) => void) => {
      const onDelta = emit ? (t: string) => emit({ type: "delta", text: t }) : undefined;
      return {
        program: harnessProgram(bodyToInput(body)),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: streamingModel(REPLY, onDelta),
        },
        clock: new TestClock(1),
        defDigest: "img",
      };
    },
  });
  return { channel, store };
}

interface SseFrame {
  type: string;
  data: Record<string, unknown>;
}
function parseSse(text: string): SseFrame[] {
  const out: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    out.push({ type, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} });
  }
  return out;
}

async function postSse(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  return res;
}

test("SSE: a streamed turn carries the full record timeline + model deltas + a terminal outcome with a rotated token", async () => {
  const { channel } = streamChannel();
  const base = await channel.listen();
  try {
    const res = await postSse(`${base}/v1/session`, {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = parseSse(await res.text());

    const records = events.filter((e) => e.type === "record");
    const deltas = events.filter((e) => e.type === "delta");
    const outcomes = events.filter((e) => e.type === "outcome");

    // the FULL timeline: model_call intent + result + a finish marker all appear
    const kindOf = (e: SseFrame) => (e.data.record as { kind: string }).kind;
    const effectKindOf = (e: SseFrame) =>
      ((e.data.record as { payload?: { effectKind?: string } }).payload ?? {}).effectKind;
    assert.ok(
      records.some((e) => kindOf(e) === "effect_intent" && effectKindOf(e) === "model_call"),
      "a model_call effect_intent record streamed",
    );
    assert.ok(records.some((e) => kindOf(e) === "effect_result"), "an effect_result record streamed");
    assert.ok(records.some((e) => kindOf(e) === "marker"), "a marker record streamed");
    assert.ok(
      records.some((e) => effectKindOf(e) === "tactic"),
      "tactic records stream too (full timeline, not model-only)",
    );

    // deltas reconcile to the model reply
    assert.equal(deltas.map((e) => e.data.text as string).join(""), REPLY);

    assert.equal(outcomes.length, 1);
    const oc = outcomes[0].data;
    assert.equal(oc.status, "finished");
    assert.equal(typeof oc.sessionId, "string");
    assert.equal(typeof oc.continuationToken, "string");

    // continue (also streamed) with the rotated token → a NEW token
    const res2 = await postSse(`${base}/v1/session/${oc.sessionId}/message`, {
      continuationToken: oc.continuationToken,
    });
    const oc2 = parseSse(await res2.text()).find((e) => e.type === "outcome")!.data;
    assert.equal(oc2.status, "finished");
    assert.notEqual(oc2.continuationToken, oc.continuationToken, "the token rotated across the streamed turn");
  } finally {
    await channel.close();
  }
});

test("SSE: a PARKED turn streams a terminal outcome with status 'parked' + the wait + a rotated token", async () => {
  const store = new MemStateStore();
  const parkProgram: Program<{ done: boolean }> = {
    initial: { done: false },
    reducer: (s) => s,
    step: () => ({ type: "wait", wait: { kind: "user" } }),
  };
  const channel = makeRestChannel({
    adapter: {
      name: "park",
      capabilities: { long_running: true },
      store,
      scheduler: new MemScheduler(),
    } as HostAdapter,
    makeTurnInputs: () => ({
      program: parkProgram,
      performers: {},
      clock: new TestClock(1),
      defDigest: "img",
    }),
  });
  const base = await channel.listen();
  try {
    const events = parseSse(await (await postSse(`${base}/v1/session`, {})).text());
    const oc = events.find((e) => e.type === "outcome")!.data;
    assert.equal(oc.status, "parked");
    assert.deepEqual(oc.wait, { kind: "user" });
    assert.equal(typeof oc.continuationToken, "string");
  } finally {
    await channel.close();
  }
});

test("SSE: a STALE token is refused with a loud JSON 4xx BEFORE any stream opens", async () => {
  const { channel } = streamChannel();
  const base = await channel.listen();
  try {
    const start = parseSse(await (await postSse(`${base}/v1/session`, {})).text());
    const oc = start.find((e) => e.type === "outcome")!.data as { sessionId: string; continuationToken: string };
    // burn the token
    await postSse(`${base}/v1/session/${oc.sessionId}/message`, { continuationToken: oc.continuationToken });
    // re-present the now-stale token, asking for a stream
    const stale = await postSse(`${base}/v1/session/${oc.sessionId}/message`, {
      continuationToken: oc.continuationToken,
    });
    assert.equal(stale.status, 409);
    assert.match(stale.headers.get("content-type") ?? "", /application\/json/, "a refusal is JSON, not a half-open SSE");
    const body = (await stale.json()) as { error?: string };
    assert.match(String(body.error), /stale|invalid/i);
  } finally {
    await channel.close();
  }
});

test("SSE: two concurrent streamed turns with the same token → exactly one wins (in-flight 409)", async () => {
  const { channel } = streamChannel();
  const base = await channel.listen();
  try {
    const start = parseSse(await (await postSse(`${base}/v1/session`, {})).text());
    const oc = start.find((e) => e.type === "outcome")!.data as { sessionId: string; continuationToken: string };
    const [a, b] = await Promise.all([
      postSse(`${base}/v1/session/${oc.sessionId}/message`, { continuationToken: oc.continuationToken }),
      postSse(`${base}/v1/session/${oc.sessionId}/message`, { continuationToken: oc.continuationToken }),
    ]);
    await Promise.all([a.text(), b.text()]); // drain both bodies
    assert.deepEqual([a.status, b.status].sort(), [200, 409], "single-use under concurrency over SSE");
  } finally {
    await channel.close();
  }
});

test("SSE: a CONTENDED turn does NOT rotate the token; the prior token stays valid for a retry", async () => {
  const store = new ContendableStore();
  const channel = makeRestChannel({
    adapter: { name: "contend", capabilities: { long_running: true }, store, scheduler: new MemScheduler() } as HostAdapter,
    makeTurnInputs: (_sid: string, body: Json, emit?: (ev: StreamEvent) => void) => {
      const onDelta = emit ? (t: string) => emit({ type: "delta", text: t }) : undefined;
      return {
        program: harnessProgram(bodyToInput(body)),
        performers: { tactic: bundle.tacticPerformer, model_call: streamingModel(REPLY, onDelta) },
        clock: new TestClock(1),
        defDigest: "img",
      };
    },
  });
  const base = await channel.listen();
  try {
    const start = parseSse(await (await postSse(`${base}/v1/session`, {})).text());
    const oc = start.find((e) => e.type === "outcome")!.data as {
      sessionId: string;
      continuationToken: string;
      status: string;
    };
    assert.equal(oc.status, "finished");

    store.contendNext = true; // the next turn's lease acquisition loses the CAS → contended
    const cont = parseSse(
      await (await postSse(`${base}/v1/session/${oc.sessionId}/message`, { continuationToken: oc.continuationToken })).text(),
    );
    const oc2 = cont.find((e) => e.type === "outcome")!.data as { status: string; continuationToken: string };
    assert.equal(oc2.status, "contended");
    assert.equal(oc2.continuationToken, oc.continuationToken, "a contended turn must NOT rotate the token");

    // the un-rotated token still works on a retry (no longer contended)
    const retry = parseSse(
      await (await postSse(`${base}/v1/session/${oc.sessionId}/message`, { continuationToken: oc.continuationToken })).text(),
    );
    assert.equal(retry.find((e) => e.type === "outcome")!.data.status, "finished");
  } finally {
    await channel.close();
  }
});

test("SSE: a turn that throws after the stream opens emits a loud 'error' event", async () => {
  const channel = makeRestChannel({
    adapter: { name: "throw", capabilities: { long_running: true }, store: new MemStateStore(), scheduler: new MemScheduler() } as HostAdapter,
    makeTurnInputs: (): never => {
      throw new Error("boom after stream opened");
    },
  });
  const base = await channel.listen();
  try {
    const res = await postSse(`${base}/v1/session`, {});
    assert.equal(res.status, 200, "the SSE head was already sent before the throw");
    const err = parseSse(await res.text()).find((e) => e.type === "error");
    assert.ok(err, "an error event was emitted");
    assert.match(String(err!.data.message), /boom/);
  } finally {
    await channel.close();
  }
});

test("SSE: a client disconnect leaves the turn durable (the session advanced in the store)", async () => {
  const { channel, store } = streamChannel(() => "fixed-sid");
  const base = await channel.listen();
  try {
    const ac = new AbortController();
    await fetch(`${base}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: "{}",
      signal: ac.signal,
    })
      .then(async (res) => {
        const reader = res.body!.getReader();
        await reader.read(); // read one chunk, then drop the connection
        ac.abort();
      })
      .catch(() => {
        /* abort throws on the client side — expected */
      });

    // the server-side turn completes and commits regardless of the disconnect
    let rows: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      rows = await store.readJournal("fixed-sid", 0);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(rows.length > 0, "the turn committed durably despite the client disconnect");
  } finally {
    await channel.close();
  }
});
