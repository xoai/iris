// `signal_recv` performer fixture for HITL (spec §3.8). On `gateAction:"ask"` the
// kernel parks on a `hitl:<callId>` signal; on resume it reads the approval as a
// `signal_recv` EFFECT, and this fixture returns the host-arranged decision.
// It returns a CONSTANT { approved } so it is idempotent across a re-perform:
// danglingIntent re-performs a dangling signal_recv intent once on recovery, and
// a non-idempotent fixture could flip approve↔deny. (Real signal-payload
// delivery over a transport is M3+; M2 does not extend the Scheduler port.)
import type { Performer, Outcome } from "@iris/core";

export interface CallCounter {
  n: number;
}

export function makeFakeSignal(approved: boolean, counter?: CallCounter): Performer {
  return async (): Promise<Outcome> => {
    if (counter) counter.n += 1;
    return { ok: true, value: { approved } };
  };
}
