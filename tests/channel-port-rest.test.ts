// channel-rest runs the shared channel-port conformance suite (roadmap v0.2 §10, plan
// T10.3) — "two channels pass the same port conformance suite", REST half. Drives the
// REAL node:http surface; a makeFlippableStore lets the suite force contended/aborted.
import type { Program, Json, JournalRecord } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeRestChannel, type TurnInputs } from "@irisrun/channel-rest";
import type { HostAdapter } from "@irisrun/host";
import { TestClock } from "./lib/mem-store.ts";
import { makeFlippableStore } from "./lib/flaky-store.ts";
import { runChannelPortConformance, type ChannelOps, type Refusal } from "./lib/channel-port-conformance.ts";

type ChState = { turns: number };
const program: Program<ChState> = {
  initial: { turns: 0 },
  reducer(state, record: JournalRecord) {
    if (record.kind === "marker" && (record.payload as { marker?: string }).marker === "finish") {
      return { turns: state.turns + 1 };
    }
    return state;
  },
  step(state) {
    return { type: "finish", output: { turn: state.turns } } as const;
  },
};

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, Json> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, Json> };
}

function mapRefusal(status: number, errorMessage: string): Refusal {
  if (status === 404) return "unknown-session";
  if (status === 400) return "missing-token";
  // 409 is both stale and in-flight — disambiguate by the loud message
  if (/in flight/i.test(errorMessage)) return "in-flight";
  return "stale-token";
}

runChannelPortConformance({
  name: "channel-rest",
  async create(): Promise<ChannelOps> {
    const { store, setNext } = makeFlippableStore(new MemoryStateStore());
    const adapter: HostAdapter = {
      name: "conformance-rest",
      capabilities: { long_running: false },
      store,
      scheduler: new MemoryScheduler(),
    };
    const makeTurnInputs = (): TurnInputs<ChState> => ({
      program,
      performers: {},
      clock: new TestClock(1),
      defDigest: "img-digest",
    });
    const channel = makeRestChannel<ChState>({ adapter, makeTurnInputs });
    const base = await channel.listen();
    return {
      async start() {
        const r = await postJson(`${base}/v1/session`, {});
        return { sessionId: r.json.sessionId as string, token: r.json.continuationToken as string };
      },
      setNext,
      async continueTurn(sessionId, token) {
        const body = token === null ? {} : { continuationToken: token };
        const r = await postJson(`${base}/v1/session/${sessionId}/message`, body);
        if (r.status === 200) {
          return { ok: true, token: r.json.continuationToken as string, status: r.json.status as string };
        }
        return { ok: false, refusal: mapRefusal(r.status, String(r.json.error ?? "")) };
      },
      close: () => channel.close(),
    };
  },
});
