// @irisrun/core — public surface (pure; no host/transport/Node-only imports).
export const PACKAGE = "@irisrun/core";

export { canonicalize, encode, decode, canonicalEqual } from "./json.ts";
export type { Json } from "./json.ts";

export type {
  LogicalTime,
  RecordKind,
  EffectKind,
  EffectIntent,
  EffectResult,
  Decision,
  WaitSpec,
  Marker,
  RecordPayload,
  JournalRecord,
} from "./journal.ts";

export { effectId } from "./effect-id.ts";

export type {
  Version,
  CasResult,
  AppendResult,
  JournalRow,
  StateStore,
  Scheduler,
} from "./ports.ts";

export type { LogicalClock } from "./clock.ts";

export type {
  Outcome,
  Action,
  Program,
  Performer,
  PerformerRegistry,
} from "./program.ts";

export { replay } from "./replay.ts";
export type { Reducer } from "./replay.ts";

export { assertReplayConsistency, ReplayDivergenceError } from "./assertion.ts";

export { acquireLease, releaseLease } from "./lease.ts";
export type { LeaseResult } from "./lease.ts";

export { runTurn, LeaseLost, SeqConflict } from "./engine.ts";
export type { EngineDeps, TurnOutcome } from "./engine.ts";

export { shouldSnapshot, DEFAULT_SNAPSHOT_THRESHOLD } from "./snapshot.ts";

export { migrateSession } from "./migrate.ts";
export type { MigrateResult } from "./migrate.ts";

// Harness layer (M2, ADR-0007) — pure seams + tactic-chain composition + kernel.
export { composeGate, composeDecideNext, composeAssemble } from "./harness/seams.ts";
export { harnessProgram } from "./harness/kernel.ts";
export type { Phase, HarnessState, HarnessInput, HarnessConfig } from "./harness/kernel.ts";
export { reactAssembleContext, reactDecideNext } from "./harness/tactics/react.ts";
export { toolRepair } from "./harness/tactics/tool-repair.ts";
export { windowCompaction } from "./harness/tactics/window-compaction.ts";
export { defaultInvariants, enforceInvariants } from "./harness/invariants.ts";
export type { Invariants } from "./harness/invariants.ts";
export { approveIrreversible } from "./harness/tactics/approve-irreversible.ts";
export { defaultBundle } from "./harness/bundle.ts";
export type { DefaultBundleOptions, Bundle } from "./harness/bundle.ts";
export type {
  ModelMessage,
  ModelContext,
  Budget,
  ToolCall,
  ErrorInfo,
  ReadonlyHarnessView,
  DecideNext,
  GateChoice,
  ToolErrorChoice,
  SeamName,
  SeamIO,
  Tactic,
  TacticChain,
} from "./harness/seams.ts";
