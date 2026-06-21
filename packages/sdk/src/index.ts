// @irisrun/sdk — one dependency to author an Iris adapter. Curated re-exports of the
// store / channel / provider port types, the three conformance suites, and the
// forkless-loader contracts. Zero runtime logic of its own; no dependency on the CLI.
export const PACKAGE = "@irisrun/sdk";

// --- store authoring ---------------------------------------------------------
export type { StateStore, Scheduler, Version, CasResult, AppendResult, JournalRow } from "@irisrun/core";
export type { WakeupSource } from "@irisrun/store-conformance";
export { runStoreConformance, runSchedulerConformance } from "@irisrun/store-conformance";

// --- channel authoring -------------------------------------------------------
export { makeChannelSession, toOutcomeEvent } from "@irisrun/channel-core";
export type { ChannelPort, Inbound, ChannelEvent, ChannelRefusal } from "@irisrun/channel-core";
export type { HostAdapter } from "@irisrun/host";
export type { MakeTurnInputs, WebHandler, TurnInputs } from "@irisrun/channel-rest";
export { runChannelPortConformance } from "@irisrun/channel-conformance";

// --- provider authoring ------------------------------------------------------
export type { Performer, Outcome, Json } from "@irisrun/core";
export type {
  ModelCallRequest,
  ModelCallResult,
  ModelMessage,
  ModelPerformerOptions,
  StreamingModelPerformerOptions,
  ConformanceFixture,
} from "@irisrun/provider-conformance";
export { runModelProviderConformance } from "@irisrun/provider-conformance";

// --- shared ------------------------------------------------------------------
// One canonical `register` + `ConformanceCase` — structurally identical across all
// three suites, so a single re-export works for store, channel, and provider cases.
export { register } from "@irisrun/store-conformance";
export type { ConformanceCase } from "@irisrun/store-conformance";

// --- forkless-loader contracts ----------------------------------------------
export type {
  OpenStore,
  OpenStoreResult,
  OpenProvider,
  ProviderFactories,
  OpenChannel,
  OpenChannelOptions,
  ChannelHandle,
} from "./contracts.ts";
