// A fixture forkless-provider module: exports `openModelProvider()` returning the two
// performer factories, exactly the @irisrun/sdk OpenProvider contract. Used by the
// --provider loader test to prove a third-party provider plugs into the CLI without a fork.
import type { OpenProvider } from "@irisrun/sdk";
import type { Performer } from "@irisrun/core";

const fakePerf: Performer = (async () => ({
  ok: true,
  value: { role: "assistant", content: "fake", stopReason: "end_turn" },
})) as never;

export const openModelProvider: OpenProvider = () => ({
  buffered: () => fakePerf,
  streaming: () => fakePerf,
});
