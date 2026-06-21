# Autoresearch loop — iterate, delegate, converge

A research task is rarely one shot: search, read, find the gap, search again.
This guide builds an agent that **loops** — delegating a research subtask,
folding the result, and deciding whether to go again — and then shows how to
**evaluate** that loop so you can change it without guessing whether it got worse.

> Builds on [Subagents](./subagents.md) (the delegation primitive),
> [Schedules](./schedules.md) (recurring runs), and
> [Audit & reproducible evals](../audit-and-evals.md) (the eval model). Read those
> for the mechanics; this guide composes them.

## The one idea: the loop is a durable session

There are two honest ways to "loop a research agent" in Iris, and they answer
different questions.

**1. Iterate within one session.** The orchestrator decides, turn by turn, to
call a `research` subagent again and refine — until *it* judges the answer
complete. The whole loop is one durable session: every delegation is journaled,
so a crash mid-loop resumes exactly where it stopped, and the loop replays
without re-running a single child. This is the right shape for "keep researching
until the question is answered."

```json
// subagents.json beside the orchestrator image
[{ "name": "research", "image": "./children/researcher" }]
```

```markdown
<!-- instructions.md -->
Research the question until you can answer it with confidence:
- Call `research` with a focused sub-question.
- If the result leaves a gap, call `research` again on that gap.
- Stop when further calls stop adding new facts, then summarize with sources.
```

```sh
iris chat ./researcher-loop/image --session q1 --db loop.sqlite --fake
# real model: set ANTHROPIC_API_KEY / OPENAI_API_KEY and drop --fake
```

The model owns the stopping decision; the child agent's `exhausted` outcome
(a turn cap) is your backstop against an unbounded loop.

**2. Recur on a timer.** When you want a research pass *every interval* — a daily
digest, a watch on a topic — express the loop as a [schedule](./schedules.md): a
durable agent that reads a logical clock, runs one job, and parks on a timer
until the next cycle. Make the job a delegation and each cycle spawns the
researcher:

```sh
iris schedule ./researcher-loop/image --interval 1440 --max-runs 30 --db watch.sqlite
```

One honest limit: a schedule's job request is fixed across cycles, so a
`subagent` job re-enters the **same** deterministic child each cycle (established
on the first run, replayed after). A *distinct* child per cycle — varying the
input each time — is in-session iteration (shape 1), or a host loop that starts a
fresh session per pass. Cycle-varying child ids are deferred.

## Set up an eval for the loop

A loop you can't measure is a loop you can't safely change. Iris's answer isn't a
subjective quality grade — it's a **reproducible arbiter**: a deterministic
scenario plus a scorer that reads the recorded session. Same scenario + scorer ⇒
byte-identical score; swap a tactic and the score moves, reproducibly. That makes
an eval a regression test for *behavior*, run with `iris eval`.

An eval **suite** is a small JS module that exports `cases` and `scorer`
(it's code, because a case builds live engine state):

```js
// research-eval.mjs
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";
// a deterministic, scripted model stands in for the LLM so the run is reproducible
import { makeScriptedModel } from "./eval-helpers.mjs";

const INPUT = { messages: [{ role: "user", content: "research X" }] };
// the model script: delegate twice, then finish
const SCRIPT = [
  { role: "assistant", content: "dig", toolCalls: [{ callId: "r1", name: "research", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "again", toolCalls: [{ callId: "r2", name: "research", args: {} }], stopReason: "tool_use" },
  { role: "assistant", content: "done", stopReason: "end_turn" },
];

export const cases = [
  {
    name: "two-pass-research",
    turns: 3,
    build() {
      const bundle = defaultBundle({ safeTools: ["research"] });
      const deps = {
        store: new MemoryStateStore(),
        scheduler: new MemoryScheduler(),
        clock: { now: () => 1 },
        program: harnessProgram(INPUT, { invariants: bundle.invariants }),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: makeScriptedModel(SCRIPT),
          // wire your real `research` subagent performer, or a scripted stand-in
        },
        defDigest: "d",
        holderId: "H",
        assertReplay: true,
      };
      return { deps, sessionId: "s" };
    },
  },
];

// the scorer reads the recorded session — not the model's prose
export const scorer = (inspection, outcome) => ({
  terminal: inspection.terminal,           // "finished" | "parked" | ...
  status: outcome.status,
  delegations: inspection.counts.effects,  // how many subtasks the loop ran
});
```

Run it — score each case, or prove the run is reproducible across N invocations:

```sh
iris eval research-eval.mjs                  # one run: prints "name: <score> (status)"
iris eval research-eval.mjs --reproduce 5    # run each case 5× and assert byte-identical
iris eval research-eval.mjs --reproduce 5 --json
```

`--reproduce` is the guarantee that matters for a loop: it re-runs each case from
a fresh build (the scripted index resets to 0) and proves the score **and** the
full journal digest are identical every time. If a change makes the loop
nondeterministic — or changes how many passes it takes — the eval fails loudly
and names the first divergence.

The full, runnable shape of a case (the exact `EngineDeps` fields, a real scripted
model and scorer) is in `tests/evals.test.ts`; the `EvalCase` / `Scorer` types
live in `@irisrun/evals`.

## Why the loop survives anything

Because both shapes are ordinary durable sessions, the substrate's properties
apply for free: a crash mid-research resumes from the journal; a finished loop
replays byte-for-byte without re-calling a model; and you can
[export the whole session](../verifiable-journal.md) and re-verify what it did
on another machine.

## Going deeper

- [Subagents](./subagents.md) · [Schedules](./schedules.md) — the two primitives.
- [Audit & reproducible evals](../audit-and-evals.md) — the eval model in full,
  plus `iris audit` for the replay-verified trail of a real run.
- [Automated workflow](./automated-workflow.md) — run the loop unattended and
  deploy it.

---

Related: [Subagents](./subagents.md) · [Schedules](./schedules.md) · [Audit & reproducible evals](../audit-and-evals.md).
