// Task 9 — C5: kernel-enforced invariants. Two DISTINCT mechanisms:
//  - cap-tightening is a RUNTIME kernel override in the reducer (forces `done`
//    when a journaled counter exceeds a cap, regardless of decideNext:"continue");
//  - remit isolation is TYPE-enforced (narrow seam signatures; no cap I/O on any
//    seam), checked here with @ts-expect-error.
// egress deny-all is a pinned constant/type-level default (no runtime network
// yet); gate-irreversible-by-default is likewise pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  harnessProgram,
  composeAssemble,
  reactAssembleContext,
  defaultInvariants,
} from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Tactic,
  Invariants,
  Performer,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { makeFakeTool, type ToolCallLog } from "./lib/fake-tool.ts";

const INPUT = { messages: [{ role: "user", content: "go" }] };

// A runaway: decideNext ALWAYS continues, model never asks for tools → without a
// cap this would loop forever.
function runawayDeps(store: MemoryStateStore, inv: Invariants): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants: inv }),
    performers: {
      tactic: makeTacticRouter((seam, payload) => {
        switch (seam) {
          case "assembleContext": {
            const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
            return composeAssemble([reactAssembleContext()], pl.state, pl.ctx);
          }
          case "shouldCompact":
            return false;
          case "decideNext":
            return "continue"; // never stops on its own
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel([{ role: "assistant", content: "n", stopReason: "end_turn" }]),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C5: maxStepsPerTurn cap halts a runaway decideNext:'continue' via the reducer override", async () => {
  const store = new MemoryStateStore();
  const inv = defaultInvariants({ maxStepsPerTurn: 3 });
  const t = await runTurn(runawayDeps(store, inv), "s");
  assert.equal(t.status, "finished", "the kernel forced the loop to finish despite 'continue'");
  const state = t.status === "finished" ? (t.state as HarnessState) : null;
  assert.ok(state && state.steps <= inv.maxStepsPerTurn + 1, `steps bounded (got ${state?.steps})`);
  assert.deepEqual(state?.output, { reply: { role: "assistant", content: "n", stopReason: "end_turn" }, halted: true });

  // C6/determinism: the override replays identically (counters are journaled)
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const program = harnessProgram(INPUT, { invariants: inv });
  assert.equal(canonicalize(replay(program.initial, records, program.reducer)), canonicalize(state));
});

test("C5: egress deny-all and gate-irreversible-by-default are pinned (only-tighten) constants", () => {
  const inv = defaultInvariants();
  assert.equal(inv.egressDefault, "deny-all");
  assert.equal(inv.gateIrreversibleByDefault, true);
});

// A tool-error storm: gate allows, the tool ALWAYS fails, and a (misconfigured)
// onToolError tactic ALWAYS retries — bounded by nothing in the tactic. Only the
// kernel step cap can stop it (steps increments on every effect, incl. each
// tool_error/tool_exec fold).
function stormDeps(store: MemoryStateStore, inv: Invariants, log: ToolCallLog): EngineDeps<HarnessState> {
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { invariants: inv }),
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
          case "onToolError":
            return { action: "retry" }; // never gives up
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel([
        { role: "assistant", content: "t", toolCalls: [{ callId: "a", name: "x", args: {} }], stopReason: "tool_use" },
      ]),
      tool_call: makeFakeTool(() => ({ ok: false, error: { message: "always fails" } }), log),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
}

test("C5: a tool-error retry storm is bounded by the kernel step cap (not just the tactic)", async () => {
  const store = new MemoryStateStore();
  const inv = defaultInvariants({ maxStepsPerTurn: 12 });
  const log: ToolCallLog = { calls: [] };
  const t = await runTurn(stormDeps(store, inv, log), "s");
  assert.equal(t.status, "finished", "the kernel step cap halted an unbounded onToolError:retry storm");
  assert.ok(
    log.calls.length > 0 && log.calls.length <= inv.maxStepsPerTurn,
    `tool attempts bounded by the step cap (got ${log.calls.length})`,
  );
});

test("C5/guard: a tactic result for the WRONG seam fails loudly (not a silent fold)", async () => {
  const store = new MemoryStateStore();
  const bogus: Performer = async (): Promise<{ ok: true; value: Json }> => ({
    ok: true,
    value: { seam: "bogusSeam", tacticId: "x", choice: null },
  });
  const deps: EngineDeps<HarnessState> = {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT),
    performers: {
      tactic: bogus,
      model_call: makeScriptedModel([{ role: "assistant", content: "d", stopReason: "end_turn" }]),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
  };
  await assert.rejects(() => runTurn(deps, "s"), /expected a 'assembleContext' tactic decision/);
});

// ── Remit isolation — TYPE-level (validated by `tsc --noEmit`, not at runtime) ──

// A shouldCompact tactic's input is { ctx, budget } only — it physically cannot
// read a gating concern (`call`): remit isolation.
// @ts-expect-error — `call` does not exist on the shouldCompact seam input
const _remitGate: Tactic<"shouldCompact"> = { id: "x", seam: "shouldCompact", decide: ({ call }) => false };

// No seam has any cap I/O, so a tactic literally cannot RAISE a cap — caps live
// only in the kernel Invariants. gateAction may only return allow|deny|ask.
// @ts-expect-error — a tactic cannot return a cap change; "raiseCap" is not a GateChoice
const _noCap: Tactic<"gateAction"> = { id: "y", seam: "gateAction", decide: () => "raiseCap" };

test("C5: remit isolation is type-enforced (the @ts-expect-error checks above compile-gate it)", () => {
  // The two declarations above only typecheck because the violations are real;
  // tsc fails the build if remit isolation ever weakens. Reference them so the
  // bindings are 'used'.
  assert.ok(typeof _remitGate === "object" && typeof _noCap === "object");
});
