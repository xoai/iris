// Phase A — @iris/client-sdk streaming (SSE). A streamed turn surfaces ordered
// `delta` text whose concatenation equals the final reply (RECONCILE invariant) and
// the committed `record` timeline; a turn that throws AFTER the stream opens emits a
// mid-stream `error` event that the SDK turns into onError() AND a rejected promise
// (a pre-open refusal would be a JSON 4xx, not an `error` event — so the fixture
// throws after the stream opens, mirroring channel-sse.test.ts:267).
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessProgram, defaultBundle } from "@iris/core";
import type { Performer, Json } from "@iris/core";
import { makeRestChannel, type StreamEvent } from "@iris/channel-rest";
import type { HostAdapter } from "@iris/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import { IrisClient, IrisError } from "@iris/client-sdk";

const REPLY = "hello there world";

// An authored streaming fake model: fires onDelta per word, returns the joined reply
// as the journaled result (channel-sse.test.ts streamingModel).
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

function streamChannel() {
  const adapter: HostAdapter = {
    name: "iris-serve-test",
    capabilities: { long_running: true },
    store: new MemStateStore(),
    scheduler: new MemScheduler(),
  };
  return makeRestChannel({
    adapter,
    makeTurnInputs: (_sid: string, body: Json, emit?: (ev: StreamEvent) => void) => {
      const onDelta = emit ? (t: string): void => emit({ type: "delta", text: t }) : undefined;
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
}

test("A2: a streamed start yields ordered deltas; join(deltas) === text === reply (reconcile)", async () => {
  const channel = streamChannel();
  const base = await channel.listen();
  try {
    const client = new IrisClient({ baseUrl: base });
    const deltas: string[] = [];
    let records = 0;
    const r = await client.start(
      { messages: [{ role: "user", content: "hi" }] },
      { stream: true, callbacks: { onDelta: (t) => deltas.push(t), onRecord: () => records++ } },
    );
    assert.equal(r.status, "finished");
    assert.equal(deltas.join(""), REPLY, "streamed deltas reconcile to the reply");
    assert.equal(r.text, REPLY, "TurnResult.text is the concatenated deltas");
    assert.ok(records > 0, "the committed record timeline streamed too");
    assert.equal(typeof client.handle?.continuationToken, "string", "adopted the token from the outcome");
  } finally {
    await channel.close();
  }
});

test("A2: a mid-stream error event → onError() AND a rejected promise (loud)", async () => {
  // A makeTurnInputs that throws AFTER the SSE head is sent (channel-sse.test.ts:267).
  const channel = makeRestChannel({
    adapter: {
      name: "throw",
      capabilities: { long_running: true },
      store: new MemStateStore(),
      scheduler: new MemScheduler(),
    } as HostAdapter,
    makeTurnInputs: (): never => {
      throw new Error("boom after stream opened");
    },
  });
  const base = await channel.listen();
  try {
    const client = new IrisClient({ baseUrl: base });
    let errored: string | null = null;
    await assert.rejects(
      () => client.start({}, { stream: true, callbacks: { onError: (m) => (errored = m) } }),
      (e: unknown) => {
        assert.ok(e instanceof IrisError);
        assert.equal((e as IrisError).code, "stream-error");
        assert.match((e as IrisError).message, /boom/);
        return true;
      },
    );
    assert.match(String(errored), /boom/, "onError fired with the mid-stream message");
  } finally {
    await channel.close();
  }
});
