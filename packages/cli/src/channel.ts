// Pluggable channel selection for `iris serve`. `--channel` picks the transport: the
// built-in `rest` (default — makeRestChannel) or ANY module specifier that exports
// `openChannel(opts)` — so a conformant first-party-grade channel (certified against
// @irisrun/channel-conformance) plugs in WITHOUT forking the CLI. This COMPLEMENTS the
// bridge pattern (an external process speaking the REST wire in any language); the loader
// is for in-process channels that reuse makeChannelSession + the streaming vocabulary.
// Default (no `--channel`) is byte-identical to before.
import { makeRestChannel } from "@irisrun/channel-rest";
import type { OpenChannel } from "@irisrun/sdk";

/** Resolve `--channel` to a channel factory. Built-in `rest` (default) → makeRestChannel;
 *  any module specifier → its exported `openChannel`. A module that fails to import or
 *  lacks the export is refused LOUDLY. Mirrors the `--store <module>` loader. */
export async function resolveChannel(channelSpec: string | undefined): Promise<OpenChannel> {
  if (channelSpec === undefined || channelSpec === "rest") {
    return makeRestChannel as OpenChannel;
  }
  let mod: { openChannel?: OpenChannel };
  try {
    mod = (await import(channelSpec)) as { openChannel?: OpenChannel };
  } catch (e) {
    throw new Error(
      `iris: --channel "${channelSpec}" — could not import the channel module (${(e as Error).message}). ` +
        'Use the built-in "rest" or a module that exports openChannel(opts).',
    );
  }
  if (typeof mod.openChannel !== "function") {
    throw new Error(
      `iris: --channel "${channelSpec}" must export openChannel(opts) — see docs/contributing/adding-a-channel.md`,
    );
  }
  return mod.openChannel;
}
