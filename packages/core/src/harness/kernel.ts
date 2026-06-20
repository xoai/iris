// The harness kernel: a Program<HarnessState> over the
// EXISTING runTurn — ZERO engine change. The loop is encoded entirely in
// HarnessState.phase (journaled → replays identically): each `step` emits ONE
// Action (a tactic/model effect, a wait, or finish) and the pure `reducer` folds
// the resulting record and advances the phase. A seam consultation is a `tactic`
// effect, so replay never re-invokes a tactic — the quarantine.
//
// This module wires the NO-TOOL spine: assemble → maybe_compact → await_model →
// decide_next → done. The tool / compaction / HITL / invariant phases exist in
// the Phase enum and are wired by later tasks; reaching an unwired phase fails
// loudly rather than silently stalling.
//
// Pure: imports stay within core (A1 / C7). No clock, no RNG, no ts reads.
import type { Json } from "../json.ts";
import type { Program, Action } from "../program.ts";
import type { JournalRecord, EffectResult, Marker, WaitSpec } from "../journal.ts";
import type {
  ModelContext,
  ReadonlyHarnessView,
  Budget,
  DecideNext,
  ToolCall,
  GateChoice,
  ToolErrorChoice,
} from "./seams.ts";
import type { Invariants } from "./invariants.ts";
import { enforceInvariants } from "./invariants.ts";

export type Phase =
  | "assemble"
  | "maybe_compact"
  | "await_model"
  | "tool_gate"
  | "tool_exec"
  | "tool_error"
  | "parked_hitl"
  | "recv_hitl"
  // interactive (chat) mode only: ingest the next user message via a user_recv
  // effect, then enter `assemble`. Initial phase when `config.interactive`.
  | "recv_user"
  | "decide_next"
  | "decide_wait"
  | "done";

export interface HarnessState extends Record<string, Json> {
  phase: Phase;
  input: Json; // the initial request, carried opaquely
  ctx: ModelContext | null;
  modelOut: Json; // last model output; null until await_model resolves
  toolCursor: number;
  steps: number;
  toolCalls: number;
  attempt: number; // failures so far for the CURRENT tool call (retry-cap input)
  lastError: Json; // the current tool call's last error (null when none)
  toolPatch: Json; // repair patch merged into the current call's args (null when none)
  pendingWait: Json; // a decideNext-requested wait spec (null unless parked on it)
  output: Json; // final output; null until done
}

export interface HarnessInput {
  messages: { role: string; content: string }[];
}

export interface HarnessConfig {
  budget?: Budget;
  // Interactive (chat) mode. When true the loop ingests each user
  // message via a `user_recv` effect, threads the conversation into `ctx`, appends
  // the assistant reply, and PARKS on a `{kind:"user"}` wait instead of finishing —
  // so the next message resumes the same durable session. Zero-value-off: absent/
  // false → the kernel is byte-identical to the non-interactive default path.
  interactive?: boolean;
  invariants?: Invariants; // when set, the kernel enforces caps via a reducer override
  // Per-tool idempotency posture. The AUTHORITATIVE source for the
  // tool_call effect's retry posture (the ToolContract's own `retrySafe` is
  // descriptive metadata only). Absent name → retrySafe:false (the safe default).
  tools?: Record<string, { retrySafe: boolean }>;
  // Subagent delegation. Tool NAMES in this set are dispatched as a `subagent`
  // effect (a child agent run) at the tool_exec step, instead of a `tool_call`, reusing
  // the gate/cursor/error machinery. Zero-value-off: absent/empty → every tool_exec still
  // emits `tool_call`, so the kernel is byte-identical to before (the gateAction approval
  // still runs upstream, so a delegate call can be allowed/denied/HITL-gated like any tool).
  // The host registers a `subagent` performer (see @irisrun/subagents).
  subagentTools?: string[];
}

function view(state: HarnessState): ReadonlyHarnessView {
  return {
    phase: state.phase,
    ctx: state.ctx,
    modelOut: state.modelOut,
    steps: state.steps,
    toolCalls: state.toolCalls,
  };
}

function tacticEffect(seam: string, payload: Json): Action {
  return { type: "effect", effectKind: "tactic", request: { seam, payload } };
}

// A model output MAY carry tool calls; the kernel routes on their presence.
function modelHasToolCalls(modelOut: Json): boolean {
  return toolCallsOf(modelOut).length > 0;
}

function toolCallsOf(modelOut: Json): ToolCall[] {
  if (modelOut === null || typeof modelOut !== "object" || Array.isArray(modelOut)) return [];
  const toolCalls = (modelOut as { toolCalls?: Json }).toolCalls;
  return Array.isArray(toolCalls) ? (toolCalls as unknown as ToolCall[]) : [];
}

function currentToolCall(state: HarnessState): ToolCall | null {
  const calls = toolCallsOf(state.modelOut);
  return state.toolCursor < calls.length ? calls[state.toolCursor] : null;
}

function mergeable(v: Json): v is { [k: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The current tool call with any repair patch merged into its (object) args.
function effectiveToolCall(state: HarnessState): ToolCall | null {
  const call = currentToolCall(state);
  if (call === null || state.toolPatch === null) return call;
  if (mergeable(call.args) && mergeable(state.toolPatch)) {
    return { ...call, args: { ...call.args, ...state.toolPatch } };
  }
  return call; // a patch only merges into object args
}

// Build a clean Json error (no undefined values), preserving a tool-suggested
// `fix`, so it can live in journaled state.
function cleanError(error: { message: string; code?: string }): Json {
  const raw = error as { message: string; code?: string; fix?: Json };
  const out: { [k: string]: Json } = { message: raw.message };
  if (raw.code !== undefined) out.code = raw.code;
  if (raw.fix !== undefined) out.fix = raw.fix;
  return out;
}

// A tactic effect result value is { seam, tacticId, choice }; extract the choice,
// cross-checking that the result's seam matches the seam the kernel asked for in
// this phase (a performer returning the wrong seam's result must fail loudly, not
// fold silently).
function tacticChoice(value: Json, expectedSeam: string): Json {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { seam?: Json }).seam === expectedSeam &&
    "choice" in value
  ) {
    return (value as { choice: Json }).choice;
  }
  throw new Error(
    `harness: expected a '${expectedSeam}' tactic decision, got ${JSON.stringify(value)}`,
  );
}

// Advance past the current tool call; route to the next gate, or to decide_next
// once the cursor passes the last call.
function advanceTool(state: HarnessState): HarnessState {
  const next = state.toolCursor + 1;
  const remaining = next < toolCallsOf(state.modelOut).length;
  return { ...state, toolCursor: next, phase: remaining ? "tool_gate" : "decide_next" };
}

function foldModel(state: HarnessState, value: Json, interactive: boolean): HarnessState {
  // Interactive mode, no more tools: append the assistant reply to the durable
  // conversation before deciding next (the conversation grows in `ctx`, which is
  // journaled via this fold → replay rebuilds it identically). Tool-call rounds
  // are unchanged (threading tool outputs back into ctx is a separate refinement).
  if (interactive && !modelHasToolCalls(value)) {
    const content =
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as { content?: Json }).content === "string"
        ? (value as { content: string }).content
        : "";
    const ctx = state.ctx ?? { messages: [] };
    const nextCtx: ModelContext = { ...ctx, messages: [...ctx.messages, { role: "assistant", content }] };
    return { ...state, modelOut: value, ctx: nextCtx, toolCursor: 0, phase: "decide_next" };
  }
  return {
    ...state,
    modelOut: value,
    toolCursor: 0,
    phase: modelHasToolCalls(value) ? "tool_gate" : "decide_next",
  };
}

function foldGate(state: HarnessState, choice: Json): HarnessState {
  const gate = choice as GateChoice;
  if (gate === "allow") return { ...state, phase: "tool_exec" };
  if (gate === "deny") return advanceTool(state); // skip this call; no tool runs
  return { ...state, phase: "parked_hitl" }; // "ask" → park for human approval
}

// HITL approval, delivered as a signal_recv effect result. Approved → run the
// tool; denied → skip it. Journaled, so replay reproduces the decision exactly.
function foldApproval(state: HarnessState, value: Json): HarnessState {
  const approved =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { approved?: Json }).approved === true;
  return approved ? { ...state, phase: "tool_exec" } : advanceTool(state);
}

function foldToolResult(state: HarnessState): HarnessState {
  // The tool output is journaled (the effect result); the loop advances by
  // cursor. Threading outputs back into the model context is a later refinement.
  // Success clears this call's retry/repair state.
  return advanceTool({
    ...state,
    toolCalls: state.toolCalls + 1,
    attempt: 0,
    lastError: null,
    toolPatch: null,
  });
}

function foldToolError(state: HarnessState, choice: Json): HarnessState {
  const decision = choice as ToolErrorChoice;
  // `retry` re-runs the CURRENT call, keeping any repair patch already applied (so
  // a repaired call that hit a transient failure retries the repaired form, not the
  // broken original). `repair` replaces the patch. Both persist until the call
  // succeeds or giveUp clears them.
  if (decision.action === "retry") return { ...state, phase: "tool_exec" };
  if (decision.action === "repair") {
    return { ...state, phase: "tool_exec", toolPatch: decision.patch ?? null };
  }
  // giveUp → skip this call and clear its retry/repair state
  return advanceTool({ ...state, attempt: 0, lastError: null, toolPatch: null });
}

function foldTactic(state: HarnessState, seam: string, choice: Json, interactive: boolean): HarnessState {
  switch (seam) {
    case "assembleContext":
      return { ...state, ctx: choice as unknown as ModelContext, phase: "maybe_compact" };
    case "shouldCompact":
      // `false` → no compaction; a ModelContext value → adopt the compacted ctx.
      // The compacted context IS the journaled tactic result, so replay reproduces
      // it without re-running the compactor (C2).
      if (choice === false) return { ...state, phase: "await_model" };
      return { ...state, ctx: choice as unknown as ModelContext, phase: "await_model" };
    case "decideNext": {
      const decision = choice as DecideNext;
      if (decision === "finish") {
        // Interactive: a "finished" reply PARKS the session on a user wait so the
        // next message resumes it (durable multi-turn). Non-interactive: finish.
        if (interactive) {
          return { ...state, phase: "decide_wait", pendingWait: { kind: "user" } };
        }
        return { ...state, phase: "done", output: { reply: state.modelOut } };
      }
      if (decision === "continue") {
        return { ...state, phase: "assemble" };
      }
      // { wait } → park on the requested wait; resume continues the loop.
      return { ...state, phase: "decide_wait", pendingWait: decision.wait };
    }
    default:
      throw new Error(`harness: unexpected tactic seam '${seam}'`);
  }
}

// Route an effect_result by the phase that emitted it: the engine is strictly
// one-effect-at-a-time, so the current phase identifies which effect this is for.
function foldResult(state: HarnessState, result: EffectResult, interactive: boolean): HarnessState {
  if (!result.outcome.ok) {
    if (state.phase === "tool_exec") {
      // a tool failure routes to the onToolError seam, carrying the error + the
      // bumped attempt count (the retry cap reads it).
      return {
        ...state,
        phase: "tool_error",
        lastError: cleanError(result.outcome.error),
        attempt: state.attempt + 1,
      };
    }
    throw new Error(
      `harness: unhandled effect failure in phase '${state.phase}': ${result.outcome.error.message}`,
    );
  }
  const value = result.outcome.value;
  switch (state.phase) {
    case "assemble":
      return foldTactic(state, "assembleContext", tacticChoice(value, "assembleContext"), interactive);
    case "maybe_compact":
      return foldTactic(state, "shouldCompact", tacticChoice(value, "shouldCompact"), interactive);
    case "await_model":
      return foldModel(state, value, interactive);
    case "recv_user": {
      // The user_recv value is { content: string }, supplied by the per-turn
      // performer. Append it to the conversation and assemble. A malformed value
      // fails LOUDLY (no silent skip) — the channel/client contract is broken.
      if (
        value === null || typeof value !== "object" || Array.isArray(value) ||
        typeof (value as { content?: Json }).content !== "string"
      ) {
        throw new Error(`harness: user_recv expected { content: string }, got ${JSON.stringify(value)}`);
      }
      const content = (value as { content: string }).content;
      const ctx = state.ctx ?? { messages: [] };
      const nextCtx: ModelContext = { ...ctx, messages: [...ctx.messages, { role: "user", content }] };
      return { ...state, ctx: nextCtx, phase: "assemble" };
    }
    case "tool_gate":
      return foldGate(state, tacticChoice(value, "gateAction"));
    case "tool_exec":
      return foldToolResult(state);
    case "tool_error":
      return foldToolError(state, tacticChoice(value, "onToolError"));
    case "recv_hitl":
      return foldApproval(state, value);
    case "decide_next":
      return foldTactic(state, "decideNext", tacticChoice(value, "decideNext"), interactive);
    default:
      throw new Error(`harness: effect result in unwired phase '${state.phase}'`);
  }
}

// The base reducer: fold a record and advance the phase. Pure; the program's
// reducer applies the invariant override on top of this.
function reduceRecord(state: HarnessState, r: JournalRecord, interactive: boolean): HarnessState {
  if (r.kind === "effect_result") {
    // every effect result is ONE loop step — this is the cap input that bounds
    // EVERY runaway (assemble loops AND tool-error retry storms).
    return foldResult({ ...state, steps: state.steps + 1 }, r.payload as EffectResult, interactive);
  }
  if (r.kind === "marker") {
    const m = r.payload as Marker;
    if (m.marker === "finish") return { ...state, phase: "done" };
    // the HITL park's wait marker advances to recv_hitl, so resume reads the
    // approval (a signal_recv effect) instead of parking again.
    if (m.marker === "wait" && state.phase === "parked_hitl") {
      return { ...state, phase: "recv_hitl" };
    }
    if (m.marker === "wait" && state.phase === "decide_wait") {
      // Interactive: a user-wait resumes by INGESTING the next message (recv_user).
      // This branch is gated on `interactive` AND `wait.kind === "user"` so a
      // NON-interactive user-wait (e.g. migrate-definition / session-pin tests)
      // still resumes to `assemble` exactly as before — byte-identity guard.
      if (interactive && m.wait.kind === "user") {
        return { ...state, phase: "recv_user", pendingWait: null };
      }
      // a decideNext-requested wait resumes the loop (back to assemble).
      return { ...state, phase: "assemble", pendingWait: null };
    }
  }
  return state; // effect_intent (no-op by contract), decisions, other markers
}

export function harnessProgram(
  input: HarnessInput,
  config: HarnessConfig = {},
): Program<HarnessState> {
  const interactive = config.interactive === true;
  return {
    initial: {
      // Interactive: start by ingesting the first user message (recv_user) with an
      // EMPTY ctx — messages arrive via user_recv, never from `input`, so `initial`
      // is identical across every turn of a session (required for stable replay).
      phase: interactive ? "recv_user" : "assemble",
      input: { messages: input.messages },
      ctx: interactive ? { messages: [] } : { messages: input.messages },
      modelOut: null,
      toolCursor: 0,
      steps: 0,
      toolCalls: 0,
      attempt: 0,
      lastError: null,
      toolPatch: null,
      pendingWait: null,
      output: null,
    },
    reducer: (state, r: JournalRecord): HarnessState => {
      const next = reduceRecord(state, r, interactive);
      const inv = config.invariants;
      if (inv) {
        // runtime kernel override: a journaled-counter breach forces the loop to
        // finish regardless of what a tactic decided. Deterministic on replay.
        const forced = enforceInvariants(next, inv);
        if (forced !== null && next.phase !== forced) {
          return {
            ...next,
            phase: forced,
            output: next.output ?? { reply: next.modelOut, halted: true },
          };
        }
      }
      return next;
    },
    step: (state): Action => {
      switch (state.phase) {
        case "assemble":
          return tacticEffect("assembleContext", {
            state: view(state),
            ctx: state.ctx ?? { messages: [] },
          });
        case "maybe_compact":
          return tacticEffect("shouldCompact", {
            ctx: state.ctx ?? { messages: [] },
            budget: config.budget ?? {},
          });
        case "await_model": {
          if (state.ctx === null) {
            throw new Error("harness: await_model reached with no assembled context");
          }
          return {
            type: "effect",
            effectKind: "model_call",
            request: { messages: state.ctx.messages },
          };
        }
        case "tool_gate": {
          const call = currentToolCall(state);
          if (call === null) throw new Error("harness: tool_gate with no current tool call");
          return tacticEffect("gateAction", { call });
        }
        case "tool_exec": {
          const call = effectiveToolCall(state);
          if (call === null) throw new Error("harness: tool_exec with no current tool call");
          // A tool NAME listed in `subagentTools` delegates to a child agent — emit
          // a `subagent` effect instead of `tool_call`. Zero-value-off: with the set
          // absent/empty the `includes` is false and the emitted action is byte-identical
          // to the tool_call path below. Retry-safe with the journaled callId as the key:
          // the child sessionId is deterministic + durable, so a recovery re-perform
          // replays the same child and returns the same output (idempotent). The result
          // folds via the existing tool_exec path (foldToolResult on success; a {ok:false}
          // routes to the handled tool_error phase — no journal-poison).
          if ((config.subagentTools ?? []).includes(call.name)) {
            return {
              type: "effect",
              effectKind: "subagent",
              request: call,
              retrySafe: true,
              idempotencyKey: call.callId,
            };
          }
          // Set retrySafe EXPLICITLY (absent config → false). The engine derives
          // `retrySafe ?? (idempotencyKey !== undefined)` — leaving retrySafe
          // undefined while attaching a key would flip a non-idempotent tool to
          // retry-safe and break the safe default. Attach the (journaled,
          // deterministic) callId as the idempotencyKey ONLY when retry-safe, so a
          // recovery re-perform can dedupe; a retry-unsafe tool gets no key and
          // triggers the engine's retry-unsafe warning on recovery.
          const retrySafe = config.tools?.[call.name]?.retrySafe ?? false;
          return retrySafe
            ? {
                type: "effect",
                effectKind: "tool_call",
                request: call,
                retrySafe: true,
                idempotencyKey: call.callId,
              }
            : { type: "effect", effectKind: "tool_call", request: call, retrySafe: false };
        }
        case "tool_error": {
          const call = currentToolCall(state);
          if (call === null) throw new Error("harness: tool_error with no current tool call");
          return tacticEffect("onToolError", {
            call,
            error: state.lastError,
            attempt: state.attempt,
          });
        }
        case "parked_hitl": {
          const call = currentToolCall(state);
          if (call === null) throw new Error("harness: parked_hitl with no current tool call");
          return { type: "wait", wait: { kind: "signal", name: `hitl:${call.callId}` } };
        }
        case "recv_hitl": {
          const call = currentToolCall(state);
          if (call === null) throw new Error("harness: recv_hitl with no current tool call");
          return { type: "effect", effectKind: "signal_recv", request: { name: `hitl:${call.callId}` } };
        }
        case "recv_user":
          // interactive mode: pull the next user message via a user_recv effect
          // (its value supplied by the per-turn channel/client performer).
          return { type: "effect", effectKind: "user_recv", request: {} };
        case "decide_next":
          return tacticEffect("decideNext", { state: view(state) });
        case "decide_wait": {
          if (state.pendingWait === null) {
            throw new Error("harness: decide_wait reached with no pending wait");
          }
          return { type: "wait", wait: state.pendingWait as unknown as WaitSpec };
        }
        case "done":
          return { type: "finish", output: state.output };
        default:
          throw new Error(`harness: phase '${state.phase}' not yet implemented`);
      }
    },
  };
}
