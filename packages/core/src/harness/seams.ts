// Harness seams: the named, narrowly-typed extension
// points where a tactic advises the kernel. Each seam is a pure `decide(input)
// -> output`; the narrow signatures are the REMIT ISOLATION guarantee — a tactic
// physically cannot reach another seam's concern (a shouldCompact tactic's type
// has no access to gating or caps).
//
// All seam IO is Json-shaped so a decision rides the `tactic` effect's result
// VALUE. The supporting structs below are `type` aliases, not interfaces: an
// object type literal is assignable to Json's `{ [k: string]: Json }` via TS's
// implicit index signature, which interface declarations do not get.
//
// Pure types + pure functions only — imports stay within core (A1 / C7).
import type { Json } from "../json.ts";
import type { WaitSpec } from "../journal.ts";

// ── Supporting seam-IO types ────────────────────────────────────────────────

export type ModelMessage = { role: string; content: string };
export type ModelContext = { messages: ModelMessage[]; tokens?: number };
export type Budget = { tokens?: number; toolCalls?: number };
export type ToolCall = { callId: string; name: string; args: Json };
// `fix` is an OPTIONAL structured correction a tool may suggest on a schema error;
// tool-repair applies it as a patch. (Widening from the spec's {message, code?} is
// safe — narrowing would be breaking.)
export type ErrorInfo = { message: string; code?: string; fix?: Json };

// A read-only projection of HarnessState handed to the context/decision seams.
// Json-shaped; the "read-only" contract is upheld by tactic purity — a tactic
// mutating its input could not affect the journaled state anyway.
export type ReadonlyHarnessView = {
  phase: string;
  ctx: ModelContext | null;
  modelOut: Json;
  steps: number;
  toolCalls: number;
};

// ── Seam outputs ────────────────────────────────────────────────────────────

export type DecideNext = "continue" | { wait: WaitSpec } | "finish";
export type GateChoice = "allow" | "deny" | "ask";
export type ToolErrorChoice = { action: "retry" | "repair" | "giveUp"; patch?: Json };

// ── Seam set + typed signatures ─────────────────────────────────────────────

export type SeamName =
  | "assembleContext"
  | "shouldCompact"
  | "decideNext"
  | "gateAction"
  | "onToolError";

// `planStep` / `spawnPolicy` are DEFERRED (not shipped) — widening a seam later
// is safe, narrowing is breaking, so we ship the minimal 5.
export interface SeamIO {
  // assembleContext is a PIPELINE: each tactic receives the accumulated `ctx`
  // (seeded empty) plus the state, and returns the next ctx. (Finalized from the
  // spec's illustrative `{ state }`-only input so the pipeline can thread ctx.)
  assembleContext: { in: { state: ReadonlyHarnessView; ctx: ModelContext }; out: ModelContext };
  // `false` → no compaction; a ModelContext → the COMPACTED context (the decision
  // IS the result, so replay reproduces it without re-running the compactor).
  shouldCompact: { in: { ctx: ModelContext; budget: Budget }; out: false | ModelContext };
  decideNext: { in: { state: ReadonlyHarnessView }; out: DecideNext };
  gateAction: { in: { call: ToolCall }; out: GateChoice };
  onToolError: { in: { call: ToolCall; error: ErrorInfo; attempt: number }; out: ToolErrorChoice };
}

export interface Tactic<S extends SeamName> {
  id: string;
  seam: S;
  decide(input: SeamIO[S]["in"]): SeamIO[S]["out"];
}

export type TacticChain<S extends SeamName> = ReadonlyArray<Tactic<S>>;

// ── Composition / precedence ────────────────────────────────────────────────

const GATE_RANK: Record<GateChoice, number> = { allow: 0, ask: 1, deny: 2 };

/** gateAction precedence: most-restrictive-wins (deny > ask > allow). Empty
 *  chain → "allow" (the neutral identity); the kernel invariant layer applies
 *  the secure gate-irreversible-by-default separately. */
export function composeGate(chain: TacticChain<"gateAction">, call: ToolCall): GateChoice {
  let worst: GateChoice = "allow";
  for (const t of chain) {
    const choice = t.decide({ call });
    if (GATE_RANK[choice] > GATE_RANK[worst]) worst = choice;
  }
  return worst;
}

/** decideNext precedence: first-decisive-wins. "continue" is NOT decisive, so the
 *  first tactic returning "finish" or a wait wins; if all say "continue", the
 *  loop continues. */
export function composeDecideNext(
  chain: TacticChain<"decideNext">,
  state: ReadonlyHarnessView,
): DecideNext {
  for (const t of chain) {
    const decision = t.decide({ state });
    if (decision !== "continue") return decision;
  }
  return "continue";
}

/** assembleContext composition: an ordered PIPELINE. Each tactic transforms the
 *  accumulated context; the seed is an empty context. */
export function composeAssemble(
  chain: TacticChain<"assembleContext">,
  state: ReadonlyHarnessView,
  seed: ModelContext = { messages: [] },
): ModelContext {
  return chain.reduce((ctx, t) => t.decide({ state, ctx }), seed);
}
