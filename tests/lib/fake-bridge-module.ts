// A fixture forkless-bridge module: exports `openBridge(opts)` returning a minimal
// PlatformAdapter (verify/parse/formatReply), exactly the @irisrun/bridge OpenBridge
// contract. Used by the bridge loader test to prove a third-party bridge plugs into
// `iris bridge` without a fork. (It does not stand up a real platform — the loader test
// exercises loading; runAdapterConformance covers adapter behavior.)
import type { OpenBridge } from "@irisrun/bridge";

export const openBridge: OpenBridge = (opts) => ({
  name: "fake",
  verify: () => true,
  parse: (rawBody) => ({ kind: "message", conversationId: opts?.env?.FAKE_CONV ?? "c", text: rawBody }),
  formatReply: (reply) => ({ echo: reply.output, status: reply.status }),
});
