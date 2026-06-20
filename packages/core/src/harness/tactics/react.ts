// The ReAct default tactics: a tool-use loop. `assembleContext` passes
// the accumulated context through (the conversation already lives in `ctx`); a
// richer prompt assembly can layer on later without a seam change. `decideNext`
// continues while the model is still requesting tools and finishes when it stops.
//
// Pure deciders — no host imports (A1 / C7).
import type { Json } from "../../json.ts";
import type { Tactic, DecideNext } from "../seams.ts";

function modelWantsTools(modelOut: Json): boolean {
  if (modelOut === null || typeof modelOut !== "object" || Array.isArray(modelOut)) return false;
  const toolCalls = (modelOut as { toolCalls?: Json }).toolCalls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

// Factory functions (not bare object exports) so core's public surface stays
// "functions only" — no module-level mutable state (the A3 structural guard).
export function reactAssembleContext(): Tactic<"assembleContext"> {
  return {
    id: "iris/react",
    seam: "assembleContext",
    decide: ({ ctx }) => ctx,
  };
}

export function reactDecideNext(): Tactic<"decideNext"> {
  return {
    id: "iris/react",
    seam: "decideNext",
    decide: ({ state }): DecideNext => (modelWantsTools(state.modelOut) ? "continue" : "finish"),
  };
}
