// A fixture forkless-channel module: exports `openChannel(opts)` returning a minimal
// ChannelHandle (listen/close), exactly the @irisrun/sdk OpenChannel contract. Used by
// the --channel loader test to prove a third-party channel plugs into the CLI without a
// fork. (It does not stand up a real server — the loader test exercises loading, not
// serving; channel-rest's own conformance covers the wire.)
import type { OpenChannel } from "@irisrun/sdk";

export const openChannel: OpenChannel = () => ({
  listen: async (): Promise<string> => "http://fake-channel.local:0",
  close: async (): Promise<void> => {},
});
