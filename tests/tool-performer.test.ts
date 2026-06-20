// T6 — the REAL tool_call performer (backed by ToolInvoker over the in-process
// transport, so this also covers in-process) replaces M2's simulated fake and
// drives the M2 kernel tool loop to finish. Effects are journaled; replay never
// re-invokes the tool — for BOTH the success and the failure path (spec §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  harnessProgram,
  composeAssemble,
  composeDecideNext,
  reactAssembleContext,
  reactDecideNext,
  toolRepair,
} from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  ToolCall,
  ErrorInfo,
  Performer,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import {
  makeToolPerformer,
  makeToolRegistry,
  makeToolInvoker,
  makeInProcessTransport,
} from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const ONE_TOOL_THEN_DONE: Json[] = [
  { role: "assistant", content: "tool", toolCalls: [{ callId: "a", name: "t", args: { x: 1 } }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

const TOOL_T: ToolContract = {
  name: "t",
  description: "the tool",
  inputSchema: {},
  transport: "in-process",
  location: "inproc://impl",
  retrySafe: false,
};

function deps(
  store: MemoryStateStore,
  tool: Performer,
  repairAttempts = 2,
): EngineDeps<HarnessState> {
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
            return "allow";
          case "onToolError": {
            const pl = payload as { call: ToolCall; error: ErrorInfo; attempt: number };
            return toolRepair(repairAttempts).decide(pl);
          }
          case "decideNext": {
            const pl = payload as { state: ReadonlyHarnessView };
            return composeDecideNext([reactDecideNext()], pl.state);
          }
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(ONE_TOOL_THEN_DONE),
      tool_call: tool,
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

async function assertReplayIdentical(store: MemoryStateStore, state: Json): Promise<void> {
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT);
  assert.equal(
    canonicalize(replay(program.initial, records, program.reducer)),
    canonicalize(state),
  );
}

test("T6: the real performer (in-process) drives the kernel loop to finish; replay never re-invokes", async () => {
  const store = new MemoryStateStore();
  let calls = 0;
  const invoker = makeToolInvoker({
    "in-process": makeInProcessTransport({
      impl: (input) => {
        calls++;
        return { received: input };
      },
    }),
  });
  const performer = makeToolPerformer(makeToolRegistry([TOOL_T]), invoker);

  const t = await runTurn(deps(store, performer), "s");
  assert.equal(t.status, "finished");
  assert.equal(calls, 1, "tool invoked exactly once during the live turn");

  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
  assert.equal(calls, 1, "replay reconstructed state from the journal WITHOUT re-invoking");
});

test("T6: an unknown tool name → loud {ok:false} (no silent success)", async () => {
  const invoker = makeToolInvoker({ "in-process": makeInProcessTransport({}) });
  const performer = makeToolPerformer(makeToolRegistry([]), invoker);
  const outcome = await performer({ callId: "a", name: "ghost", args: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, "unknown_tool");
});

test("T6: a FAILED tool call is also replay-stable (recorded error read on replay, never re-invoked)", async () => {
  const store = new MemoryStateStore();
  let calls = 0;
  const invoker = makeToolInvoker({
    "in-process": makeInProcessTransport({
      impl: () => {
        calls++;
        throw new Error("boom");
      },
    }),
  });
  const performer = makeToolPerformer(makeToolRegistry([TOOL_T]), invoker);

  const t = await runTurn(deps(store, performer, 2), "s"); // toolRepair gives up after 2
  assert.equal(t.status, "finished", "loop finishes after giving up on the failing tool");
  const liveCalls = calls;
  assert.ok(liveCalls >= 1, "tool was invoked at least once during the live turn");

  await assertReplayIdentical(store, t.status === "finished" ? t.state : null);
  assert.equal(calls, liveCalls, "replay read the recorded {ok:false} — never re-invoked");
});
