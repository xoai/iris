// T8 — hold-and-migrate, against a REAL runTurn journal (not
// a synthetic fixture). engine.ts is byte-untouched: migration appends the EXISTING
// `upgraded` marker host-side; the marker folds to a reducer state no-op so replay
// stays byte-consistent across the migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTurn,
  replay,
  canonicalize,
  decode,
  encode,
  acquireLease,
  harnessProgram,
  composeAssemble,
  reactAssembleContext,
} from "@irisrun/core";
import type {
  EngineDeps,
  HarnessState,
  JournalRecord,
  ReadonlyHarnessView,
  ModelContext,
  Json,
} from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
import { TestClock } from "./lib/mem-store.ts";
import { makeScriptedModel } from "./lib/fake-model.ts";
import { makeTacticRouter } from "./lib/fake-tactic.ts";
import { governingDigest, migrateDefinition } from "@irisrun/agent";

const INPUT = { messages: [{ role: "user", content: "hi" }] };
const MODEL_OUT: Json[] = [{ role: "assistant", content: "hello", stopReason: "end_turn" }];

function deps(
  store: MemoryStateStore,
  defDigest: string,
  snapshotThreshold?: number,
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
          case "decideNext":
            return { wait: { kind: "user" } };
          default:
            throw new Error(`unexpected seam ${seam}`);
        }
      }),
      model_call: makeScriptedModel(MODEL_OUT),
    },
    defDigest,
    holderId: "H",
    assertReplay: true,
    snapshotThreshold,
  };
}

async function recs(store: MemoryStateStore, sid: string): Promise<JournalRecord[]> {
  const rows = await store.readJournal(sid, 0);
  return rows.map((r) => decode(r.bytes) as unknown as JournalRecord);
}

test("T8: migrate writes the upgraded marker at a turn boundary; resume runs under `to`; replay byte-consistent", async () => {
  const store = new MemoryStateStore();
  const t1 = await runTurn(deps(store, "imgA"), "s");
  assert.equal(t1.status, "parked");
  assert.equal(await governingDigest(store, "s"), "imgA");

  await migrateDefinition(store, "s", { from: "imgA", to: "imgB" });

  const after = await recs(store, "s");
  const upgraded = after.find(
    (r) => r.kind === "marker" && (r.payload as { marker?: string }).marker === "upgraded",
  );
  assert.ok(upgraded, "an upgraded marker was written");
  const payload = upgraded!.payload as { from: string; to: string; atTurn: number };
  assert.equal(payload.from, "imgA");
  assert.equal(payload.to, "imgB");
  assert.equal(upgraded!.defDigest, "imgB");
  assert.equal(payload.atTurn, upgraded!.seq, "atTurn = boundary seq (NOT a turn_started count)");
  assert.ok(upgraded!.seq > 0);
  assert.equal(await governingDigest(store, "s"), "imgB");

  // resume under imgB → new records carry imgB
  const t2 = await runTurn(deps(store, "imgB"), "s");
  assert.equal(t2.status, "parked");

  const final = await recs(store, "s");
  const boundary = upgraded!.seq;
  assert.ok(
    final.filter((r) => r.seq < boundary).every((r) => r.defDigest === "imgA"),
    "pre-migration records carry imgA",
  );
  assert.ok(
    final.filter((r) => r.seq >= boundary).every((r) => r.defDigest === "imgB"),
    "the marker + post-migration records carry imgB",
  );

  // replay byte-consistent across the migration (upgraded marker = state no-op)
  const program = harnessProgram(INPUT);
  assert.equal(
    canonicalize(replay(program.initial, final, program.reducer)),
    canonicalize(t2.status === "parked" ? t2.state : null),
  );
});

test("T8: migrate refuses a never-started session and a wrong `from`, loudly", async () => {
  const store = new MemoryStateStore();
  await assert.rejects(
    () => migrateDefinition(store, "ghost", { from: "imgA", to: "imgB" }),
    /has not started/i,
  );
  await runTurn(deps(store, "imgA"), "s");
  await assert.rejects(
    () => migrateDefinition(store, "s", { from: "WRONG", to: "imgB" }),
    /governing digest/i,
  );
});

test("T8: migrate refuses when not at a turn boundary (latest record is not a terminal marker)", async () => {
  const store = new MemoryStateStore();
  const lease = await acquireLease(store, "mid", "setup");
  const fence = lease.ok ? lease.fence : 0;
  const rec: JournalRecord = {
    seq: 0,
    ts: 0,
    defDigest: "imgA",
    kind: "effect_result",
    payload: { effectId: "x:0", outcome: { ok: true, value: null } },
  };
  const r = await store.append("mid", 0, [encode(rec as unknown as Json)], fence);
  assert.ok(r.ok);
  await assert.rejects(
    () => migrateDefinition(store, "mid", { from: "imgA", to: "imgB" }),
    /turn boundary/i,
  );
});

test("T8: migrate is snapshot-safe — works after a snapshot has truncated the journal", async () => {
  const store = new MemoryStateStore();
  // snapshotThreshold:1 → the engine snapshots + truncates during the turn
  const t = await runTurn(deps(store, "imgA", 1), "s");
  assert.equal(t.status, "parked");
  // the tail starts above the snapshot, yet governingDigest still reads the pin
  assert.equal(await governingDigest(store, "s"), "imgA");
  await migrateDefinition(store, "s", { from: "imgA", to: "imgB" });
  assert.equal(await governingDigest(store, "s"), "imgB");
});
