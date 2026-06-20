// Record-replay FIDELITY for model_call (roadmap v0.2 P2 #7; the precise §8
// determinism claim). The existing B1 (model-effect.test.ts) proves resume does
// not re-call the provider via a call counter. This goes further and makes the
// proof non-vacuous in two ways the spec review demanded:
//   1. The original performer is NONDETERMINISTIC (its value encodes the call
//      ordinal), so we prove the replayed value is the RECORDED one — not merely
//      that a count is unchanged.
//   2. We PARK after the model_call and resume on a FRESH engine whose model_call
//      performer is a POISON PILL — so if the engine ever re-issued the recorded
//      effect on replay, the poison fires loudly. A correct engine reads the
//      journal and never touches the performer.
// The nondeterminism lives ONLY in the journaled return value (never in anything
// the reducer recomputes), so the always-on replay-consistency assertion does
// not false-fire.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Performer, Outcome } from "@irisrun/core";
import { recordThenResumeWithPoison } from "./lib/model-call-fidelity.ts";

test("fidelity: a recorded model_call replays to the byte-identical value; resume never re-invokes the performer", async () => {
  // A NONDETERMINISTIC model performer: each invocation returns a distinct value,
  // so a re-invocation would be observable by VALUE, not just by count.
  const counter = { n: 0 };
  const nondeterministic: Performer = async (): Promise<Outcome> => {
    counter.n += 1;
    return { ok: true, value: { role: "assistant", content: `v${counter.n}`, stopReason: "end_turn" } };
  };

  const run = await recordThenResumeWithPoison(nondeterministic);

  assert.ok(run.parkedOk, "original turn parks after the model_call");
  assert.equal(counter.n, 1, "model performer invoked exactly once on the live turn");
  assert.ok(run.finishedOk, "resume finishes from the journaled state");
  assert.equal(run.poisonFired, 0, "the poison-pill performer was never invoked (no re-issue on replay)");
  assert.equal(counter.n, 1, "the original performer's count is unchanged after resume");
  assert.deepEqual(
    run.recordedReply,
    { role: "assistant", content: "v1", stopReason: "end_turn" },
    "the replayed value is the FIRST recorded value, not a fresh nondeterministic one",
  );
});
