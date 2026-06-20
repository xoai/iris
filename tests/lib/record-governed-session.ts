// Shared recorder for audit/verify/cli tests: drives a full
// park→approve→resume GOVERNED harness session (a real journal with tactic/model/
// tool effects, a governed signal_recv approval, and markers) onto a fresh store.
// Mirrors the proven deps() in auth-governance-integration.test.ts.
import {
  runTurn,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
} from "@irisrun/core";
import type { EngineDeps, HarnessState, ReadonlyHarnessView, ModelContext, Performer, Json, Reducer } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./mem-store.ts";
import { makeScriptedModel, makeFakeModel } from "./fake-model.ts";
import { makeTacticRouter } from "./fake-tactic.ts";
import { makeFakeTool } from "./fake-tool.ts";
import { createApprovalInbox, makeGovernedApprovalPerformer } from "@irisrun/auth";
import type { ApprovalPolicy, GovernedAction, RawApproval } from "@irisrun/auth";
import assert from "node:assert/strict";

export const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "rm", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];
const RM: GovernedAction = { name: "rm", callId: "a" };
const ALICE_APPROVE: RawApproval = { principal: { id: "alice", roles: ["dev"] }, intent: "approve" };
const GRANTS_DEV: ApprovalPolicy = { rules: [{ tool: "rm", anyOfRoles: ["dev"] }] };

export type RecordOpts = { snapshotThreshold?: number; keepHistory?: boolean };

/** The non-interactive harness reducer/initial that recordGovernedSession records under
 *  (what verifySession must replay with). */
export function harnessReducer(): Reducer<HarnessState> {
  return harnessProgram(INPUT).reducer;
}
export function harnessInitial(): HarnessState {
  return harnessProgram(INPUT).initial;
}

function deps(store: MemoryStateStore, model: Performer, tool: Performer, signal: Performer, o: RecordOpts = {}): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact":
            return false;
          case "gateAction":
            return "ask";
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: model,
      tool_call: tool,
      signal_recv: signal,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    ...(o.snapshotThreshold !== undefined ? { snapshotThreshold: o.snapshotThreshold } : {}),
    ...(o.keepHistory !== undefined ? { keepHistory: o.keepHistory } : {}),
  };
}

/** Record a governed park→approve→resume session; returns the populated store. */
export async function recordGovernedSession(o: RecordOpts = {}): Promise<MemoryStateStore> {
  const store = new MemoryStateStore();
  const inbox = createApprovalInbox();
  const model = makeScriptedModel(ONE_TOOL_THEN_DONE);
  const tool = makeFakeTool(() => ({ ok: true, value: { done: 1 } }));
  const signal = makeGovernedApprovalPerformer({ policy: GRANTS_DEV, inbox });

  const t1 = await runTurn(deps(store, model, tool, signal, o), "s");
  assert.equal(t1.status, "parked");
  inbox.submit(RM, ALICE_APPROVE);
  const t2 = await runTurn(deps(store, model, tool, signal, o), "s");
  assert.equal(t2.status, "finished");
  return store;
}

// A user_recv performer delivering one fixed message (mirrors harness-interactive.test.ts).
function userMessage(content: Json): Performer {
  return async (): Promise<{ ok: true; value: Json }> => ({ ok: true, value: { content } });
}

function reactRouter(): Performer {
  return makeTacticRouter((seam, payload) => {
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
      }
      case "shouldCompact":
        return false;
      case "decideNext": {
        const pl = payload as { state: ReadonlyHarnessView };
        return composeDecideNext([reactDecideNext()], pl.state);
      }
      case "gateAction":
        return "allow";
      case "onToolError":
        return { action: "giveUp" };
      default:
        throw new Error(`unexpected seam ${seam}`);
    }
  });
}

/** Record a single INTERACTIVE turn (ingests a user message, replies, parks on a
 *  {kind:"user"} wait). Used for the C1 interactivity-auto-detection test. */
export async function recordInteractiveSession(): Promise<MemoryStateStore> {
  const store = new MemoryStateStore();
  const t = await runTurn(
    {
      store,
      scheduler: new MemoryScheduler(),
      clock: new TestClock(1),
      program: harnessProgram({ messages: [] }, { interactive: true }),
      performers: { tactic: reactRouter(), model_call: makeFakeModel(), user_recv: userMessage("hi") },
      defDigest: "d",
      holderId: "H",
      assertReplay: true,
    },
    "s",
  );
  assert.equal(t.status, "parked");
  return store;
}
