// T7 — tool-call recovery / idempotency (ADR-0003), proving the §3.5 derivation
// end-to-end with NO engine change. The kernel sets retrySafe EXPLICITLY and
// attaches idempotencyKey=callId ONLY when retry-safe; the engine's existing
// danglingIntent recovery re-performs a dangling tool_call once, warns on a
// retry-unsafe re-perform, and passes the idempotencyKey through to the tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  acquireLease,
  encode,
  decode,
  harnessProgram,
  composeAssemble,
  reactAssembleContext,
} from "@irisrun/core";
import type {
  EngineDeps,
  JournalRecord,
  HarnessState,
  ReadonlyHarnessView,
  ModelContext,
  Json,
  Version,
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
import type { ToolContract, InProcessFn } from "@irisrun/tools";

const INPUT = { messages: [{ role: "user", content: "go" }] };
const TOOL_OUTPUT: Json[] = [
  { role: "assistant", content: "t", toolCalls: [{ callId: "a", name: "t", args: { x: 1 } }], stopReason: "tool_use" },
];
const TOOL_T: ToolContract = {
  name: "t",
  description: "the tool",
  inputSchema: {},
  transport: "in-process",
  location: "inproc://impl",
  retrySafe: false, // descriptive only; the harness config below is authoritative
};

function deps(
  store: MemoryStateStore,
  fn: InProcessFn,
  toolsConfig: Record<string, { retrySafe: boolean }>,
  warnings: string[],
): EngineDeps<HarnessState> {
  const invoker = makeToolInvoker({ "in-process": makeInProcessTransport({ impl: fn }) });
  return {
    store,
    scheduler: new MemoryScheduler(),
    clock: new TestClock(1),
    program: harnessProgram(INPUT, { tools: toolsConfig }),
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
          case "decideNext":
            return "finish"; // finish right after the single tool — no 2nd model call
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(TOOL_OUTPUT),
      tool_call: makeToolPerformer(makeToolRegistry([TOOL_T]), invoker),
    },
    defDigest: "d",
    holderId: "H",
    assertReplay: true,
    onWarn: (m: string) => warnings.push(m),
  };
}

interface ToolIntent {
  effectKind: string;
  retrySafe?: boolean;
  idempotencyKey?: string;
}

async function toolIntentOf(store: MemoryStateStore): Promise<ToolIntent> {
  const rows = await store.readJournal("s", 0);
  const records = rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
  const rec = records.find(
    (r) => r.kind === "effect_intent" && (r.payload as ToolIntent).effectKind === "tool_call",
  );
  assert.ok(rec, "expected a tool_call effect_intent in the journal");
  return rec!.payload as ToolIntent;
}

// Generate a finished turn, then keep records through the tool_call intent only
// (drop its result + everything after) → a store with a DANGLING tool_call intent.
async function storeWithDanglingTool(records: JournalRecord[]): Promise<MemoryStateStore> {
  const idx = records.findIndex(
    (r) => r.kind === "effect_intent" && (r.payload as ToolIntent).effectKind === "tool_call",
  );
  assert.ok(idx >= 0, "expected a tool_call intent to truncate at");
  const kept = records.slice(0, idx + 1);
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "s", "setup");
  const fence: Version = lease.ok ? lease.fence : 0;
  const r = await store.append(
    "s",
    kept[0].seq,
    kept.map((rec) => encode(rec as unknown as Json)),
    fence,
  );
  assert.ok(r.ok, `rebuild append failed: ${JSON.stringify(r)}`);
  return store;
}

async function recordsOf(store: MemoryStateStore): Promise<JournalRecord[]> {
  const rows = await store.readJournal("s", 0);
  return rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
}

test("T7: kernel writes a retry-UNSAFE tool_call intent — retrySafe:false, NO idempotencyKey, performer gets no key", async () => {
  const store = new MemoryStateStore();
  let calls = 0;
  let lastKey: string | undefined;
  const fn: InProcessFn = (_input, key) => {
    calls++;
    lastKey = key;
    return { ok: 1 };
  };
  const t = await runTurn(deps(store, fn, { t: { retrySafe: false } }, []), "s");
  assert.equal(t.status, "finished");
  const intent = await toolIntentOf(store);
  assert.equal(intent.retrySafe, false);
  assert.equal("idempotencyKey" in intent, false, "no idempotencyKey on a retry-unsafe intent");
  assert.equal(calls, 1);
  assert.equal(lastKey, undefined, "performer received no idempotencyKey");
});

test("T7: kernel writes a retry-SAFE tool_call intent — retrySafe:true, idempotencyKey=callId, performer gets the key", async () => {
  const store = new MemoryStateStore();
  let lastKey: string | undefined;
  const fn: InProcessFn = (_input, key) => {
    lastKey = key;
    return { ok: 1 };
  };
  const t = await runTurn(deps(store, fn, { t: { retrySafe: true } }, []), "s");
  assert.equal(t.status, "finished");
  const intent = await toolIntentOf(store);
  assert.equal(intent.retrySafe, true);
  assert.equal(intent.idempotencyKey, "a", "retry-safe intent carries the callId as idempotencyKey");
  assert.equal(lastKey, "a", "performer received the idempotencyKey for dedupe");
});

test("T7(a): recovery of a retry-UNSAFE dangling tool_call → re-performed once, retry-unsafe warning, NO key", async () => {
  const gen = new MemoryStateStore();
  await runTurn(deps(gen, () => ({ ok: 1 }), { t: { retrySafe: false } }, []), "s");
  const store = await storeWithDanglingTool(await recordsOf(gen));

  let calls = 0;
  let lastKey: string | undefined = "UNSET";
  const warnings: string[] = [];
  const fn: InProcessFn = (_input, key) => {
    calls++;
    lastKey = key;
    return { ok: 1 };
  };
  const t = await runTurn(deps(store, fn, { t: { retrySafe: false } }, warnings), "s");
  assert.equal(t.status, "finished");
  assert.equal(calls, 1, "the dangling tool_call is re-performed exactly once on recovery");
  assert.equal(lastKey, undefined, "retry-unsafe re-perform carries NO idempotencyKey");
  assert.ok(
    warnings.some((w) => /retry-unsafe/.test(w)),
    `expected a retry-unsafe warning, got ${JSON.stringify(warnings)}`,
  );
});

test("T7(b): recovery of a retry-SAFE dangling tool_call → re-performed once with idempotencyKey=callId, NO warning", async () => {
  const gen = new MemoryStateStore();
  await runTurn(deps(gen, () => ({ ok: 1 }), { t: { retrySafe: true } }, []), "s");
  const store = await storeWithDanglingTool(await recordsOf(gen));

  let calls = 0;
  let lastKey: string | undefined;
  const warnings: string[] = [];
  const fn: InProcessFn = (_input, key) => {
    calls++;
    lastKey = key;
    return { ok: 1 };
  };
  const t = await runTurn(deps(store, fn, { t: { retrySafe: true } }, warnings), "s");
  assert.equal(t.status, "finished");
  assert.equal(calls, 1, "the dangling tool_call is re-performed exactly once on recovery");
  assert.equal(lastKey, "a", "retry-safe re-perform carries idempotencyKey=callId for dedupe");
  assert.equal(
    warnings.some((w) => /retry-unsafe/.test(w)),
    false,
    "a retry-safe re-perform must NOT warn",
  );
});
