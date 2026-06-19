// The application contract the engine drives (spec §3.2). Three PURE pieces:
// initial state, a reducer (drives replay), and a stepper (chooses the next
// action). State is `Json` so snapshot round-trips are identity (spec §3.9).
import type { Json } from "./json.ts";
import type { JournalRecord, EffectKind, WaitSpec } from "./journal.ts";

export type Outcome =
  | { ok: true; value: Json }
  | { ok: false; error: { message: string; code?: string } };

export type Action =
  | {
      type: "effect";
      effectKind: EffectKind;
      request: Json;
      idempotencyKey?: string;
      retrySafe?: boolean;
    }
  | { type: "wait"; wait: WaitSpec }
  | { type: "finish"; output?: Json };

export interface Program<S extends Json> {
  initial: S;
  // PURE. Reconstructs state by folding a record. MUST NOT read `record.ts`,
  // call a clock/RNG, or rely on hash-map order (spec §3.8, §3.2).
  reducer(state: S, record: JournalRecord): S;
  // PURE given state. Chooses the next action; never performs side effects.
  step(state: S): Action;
}

// Effects are performed by injected functions supplied by the runner/host —
// never by core. On replay these are never called (results come from the
// journal), which is why core does no I/O of its own (spec §3.3).
export type Performer = (
  request: Json,
  idempotencyKey?: string,
) => Promise<Outcome>;

export type PerformerRegistry = Partial<Record<EffectKind, Performer>>;
