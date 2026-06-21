// The three forkless-loader CONTRACTS — the factory shapes a third-party store /
// provider / channel package exports for `--store` / `--provider` / `--channel`.
// Canonical here so the CLI loaders and adapter authors share ONE definition.
import type { StateStore, Scheduler, Performer, Json } from "@irisrun/core";
import type { WakeupSource } from "@irisrun/store-conformance";
import type { ModelPerformerOptions, StreamingModelPerformerOptions } from "@irisrun/provider-conformance";
import type { RestChannelOptions } from "@irisrun/channel-rest";

// --- store -------------------------------------------------------------------
/** What a pluggable store module returns from `openStore({ url })`. The scheduler
 *  must also implement the host-side WakeupSource (dueWakeups/confirmWoken) — the
 *  store-conformance suite certifies both. */
export interface OpenStoreResult {
  store: StateStore;
  scheduler: Scheduler & WakeupSource;
  close?(): Promise<void> | void;
}
/** The factory a third-party store package exports for `--store <module>`. */
export type OpenStore = (opts: { url: string }) => OpenStoreResult | Promise<OpenStoreResult>;

// --- provider ----------------------------------------------------------------
/** The buffered + streaming model_call performer factories a provider exposes. */
export interface ProviderFactories {
  buffered(opts?: ModelPerformerOptions): Performer;
  streaming(opts?: StreamingModelPerformerOptions): Performer;
}
/** The factory a third-party provider package exports for `--provider <module>`. */
export type OpenProvider = () => ProviderFactories | Promise<ProviderFactories>;

// --- channel -----------------------------------------------------------------
/** Options a channel receives — structurally the channel-rest RestChannelOptions
 *  (the same object `iris serve` builds), so the default makeRestChannel and a
 *  custom channel are interchangeable. */
export type OpenChannelOptions<S extends Json> = RestChannelOptions<S>;
/** The minimal handle a channel returns. The built-in RestChannel is assignable
 *  (it has `listen`/`close` plus an extra `server`). */
export interface ChannelHandle {
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}
/** The factory a third-party channel package exports for `--channel <module>`. */
export type OpenChannel = <S extends Json>(
  opts: OpenChannelOptions<S>,
) => ChannelHandle | Promise<ChannelHandle>;
