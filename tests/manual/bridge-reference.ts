// Reference bridge DEMO (roadmap v0.2 §12) — `npm run demo:bridge`. Stands up an
// in-process Iris REST channel and drives a two-turn conversation through the
// fetch-only webhook bridge (webhook-bridge.ts), showing that a platform bridge needs
// only the wire protocol and ZERO core changes. The bridge is the external process;
// this harness only plays the role of "Iris is already running over here".
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { makeRestChannel, type TurnInputs } from "@irisrun/channel-rest";
import type { Program, Json, JournalRecord } from "@irisrun/core";
import type { HostAdapter } from "@irisrun/host";
import { makeWebhookBridge } from "./webhook-bridge.ts";

type ChState = { turns: number };

// A trivial finishing program: each turn finishes with output {turn:n}, so successive
// turns through the bridge are distinguishable (proving session continuity).
export const bridgeDemoProgram: Program<ChState> = {
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

export function makeBridgeDemoChannel() {
  const adapter: HostAdapter = {
    name: "bridge-demo",
    capabilities: { long_running: false },
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
  };
  const makeTurnInputs = (): TurnInputs<ChState> => ({
    program: bridgeDemoProgram,
    performers: {},
    clock: { now: () => 0 },
    defDigest: "bridge-demo",
  });
  return makeRestChannel<ChState>({ adapter, makeTurnInputs });
}

export async function runBridgeDemo(log: (m: string) => void = console.log): Promise<void> {
  const channel = makeBridgeDemoChannel();
  const baseUrl = await channel.listen();
  try {
    const bridge = makeWebhookBridge({ baseUrl });
    log(`bridge demo: Iris REST channel on ${baseUrl}; driving a 2-turn conversation through the bridge`);
    const r1 = await bridge.onMessage({ conversationId: "discord:guild/chan/thread-7", text: "hello" });
    log(`  turn 1 → status=${r1.status} output=${JSON.stringify(r1.output)}`);
    const r2 = await bridge.onMessage({ conversationId: "discord:guild/chan/thread-7", text: "again" });
    log(`  turn 2 → status=${r2.status} output=${JSON.stringify(r2.output)}`);
    log("bridge demo: same conversation, token adopted+rotated across turns — zero core changes.");
  } finally {
    await channel.close();
  }
}

// `npm run demo:bridge` runs this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runBridgeDemo();
}
