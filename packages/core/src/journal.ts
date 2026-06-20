// Journal record model. Types only — the
// journal is the single source of truth; state is reconstructed by replaying it.

import type { Json } from "./json.ts";

export type LogicalTime = number;

export type RecordKind =
  | "effect_intent"
  | "effect_result"
  | "decision"
  | "marker";

// `clock`, `echo`, and `model_call` have wired performers; `tactic` is the
// harness seam consultation — performed host-side via the existing
// PerformerRegistry exactly like model_call, so replay never re-invokes it. The
// rest are reserved entry types (each wired by the package that owns its effect,
// e.g. `subagent` by @irisrun/subagents).
export type EffectKind =
  | "clock"
  | "random"
  | "echo"
  | "signal_recv"
  // a user message delivered into an interactive (chat) session — the value is
  // supplied per-turn by the channel/client performer (interactive mode),
  // so it is journaled and replay never re-reads a live input.
  | "user_recv"
  | "model_call"
  | "tool_call"
  | "tactic"
  | "subagent";

export interface EffectIntent {
  effectId: string;
  effectKind: EffectKind;
  idempotencyKey?: string;
  request: Json;
  // Idempotency posture. Keyed/retry-safe effects are re-performed
  // on recovery; unsafe ones are flagged so the risk is visible.
  retrySafe: boolean;
}

export interface EffectResult {
  effectId: string;
  outcome:
    | { ok: true; value: Json }
    | { ok: false; error: { message: string; code?: string } };
}

// Control-flow choice from a harness tactic. Record type ships for
// forward-compat; the engine does not emit decisions in this slice.
export interface Decision {
  seam: string;
  tacticId: string;
  choice: Json;
}

export type WaitSpec =
  | { kind: "user" }
  | { kind: "signal"; name: string }
  | { kind: "timer"; at: LogicalTime };

export type Marker =
  | { marker: "turn_started" }
  | { marker: "wait"; wait: WaitSpec }
  | { marker: "finish"; output?: Json }
  // record-only in this slice: snapshots are written to the store's snapshot
  // table, not appended to the journal. Type ships for forward-compat.
  | { marker: "snapshot"; upToSeq: number }
  // version stamp; record-only here.
  | { marker: "upgraded"; from: string; to: string; atTurn: number };

export type RecordPayload = EffectIntent | EffectResult | Decision | Marker;

export interface JournalRecord {
  seq: number; // dense, monotonic within a session
  ts: LogicalTime; // recorded; never read from a wall clock at replay
  defDigest: string; // governing image digest for this segment
  kind: RecordKind;
  payload: RecordPayload;
  // DETERMINISM CONTRACT: `reducer` and `step` MUST NOT read `ts`.
  // It is audit/observability metadata only. Application time must flow through
  // a `clock` effect (its value lands in state via a result), never via
  // record.ts. A reducer that branches on `ts` is a determinism leak the replay
  // assertion cannot catch (live and replay see the same recorded `ts`).
}
