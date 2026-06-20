# Schedules

A schedule is a recurring job — but not a cron entry that fires a fresh script
each time. It's a single **durable, replayable agent** that loops: read the
clock, run one job, park on a timer until the next run. The cadence lives in the
journal, so the whole schedule replays byte-for-byte. Run it with `iris schedule`.

> This builds on two ideas you've already met: a session **is** its journal
> ([Audit & reproducible evals](../audit-and-evals.md)), and the kernel records
> decisions instead of re-running them ([The harness](../harness.md)). A schedule
> is what you get when a recurring job is expressed against that same substrate.

## The one idea: cadence is journaled, not wall-clock

A normal scheduler reads the wall clock to decide when to fire. That read is
ambient — replay it later and you get a different answer. A schedule built this
way couldn't replay.

`scheduleProgram` reads a **logical clock** instead — a journaled `clock` effect.
Each cycle:

1. **read_clock** — emit a `clock` effect; the result (`now`) is recorded.
2. **run_job** — run exactly one job effect; its result is recorded as `lastJob`.
3. **park** — emit a durable timer wait at `now + intervalTicks`.

On the next wake the program loops back to step 1. Cadence derives **only** from
journaled clock results, never from the record's wall-clock timestamp — so
folding the same journal twice yields the same state. The `schedule-program`
test proves exactly that: replaying a two-cycle journal twice gives an identical
`ScheduleState`.

The whole thing is a **pure** `Program` — no I/O, no clock or RNG reads of its
own. It just reduces journal records into state and emits the next `Action`.

## Anatomy of a schedule

You configure three things (`ScheduleConfig` in
`packages/schedule/src/program.ts`):

| Field | Meaning |
|---|---|
| `intervalTicks` | logical-time units between runs — a positive integer |
| `maxRuns` | finish after this many job runs — a positive integer |
| `job` | the per-cycle effect: `{ effectKind, request }` |

Construction validates loudly: a non-integer or non-positive `intervalTicks` /
`maxRuns`, or a malformed `job`, throws on the spot — before any turn runs.

The `job` is one effect per cycle. The program doesn't care what kind — its
performer is supplied by the host. The demo and CLI wire a keyless `echo`
heartbeat; tests also drive a `tool_call` and a `subagent` spawn. So "the job"
can be a no-op tick, a real tool, or a delegation — same loop either way.

State the program tracks (`ScheduleState`):

- `phase` — `read_clock` · `run_job` · `park` · `done`
- `runs` — completed job runs
- `now` / `nextAt` — last clock reading, and the next wake time
- `lastJob` — the last job's result value, or `{ error }` on a failed job

A **failed job does not stop the schedule.** The reducer folds the failure into
`lastJob` as `{ error }`, counts the run, and keeps going (or finishes if it hit
`maxRuns`). A pure reducer must never throw on a journaled record, so even a
job that errored is just data in the audit trail.

## The pump: how a parked schedule wakes up

The program parks. Something has to notice the timer is due and resume it. That's
the **pump** — `makeScheduleRunner`, the host-side driver in
`packages/schedule/src/runner.ts`. It's multi-session: one pump advances every
schedule whose timer is due.

Each call to `tick(now)`:

1. asks the scheduler for `dueWakeups(now)` — sessions whose timer or signal has
   come due;
2. for each (deduped — a session with both a due timer and signal resumes once),
   resumes it with `runTurnOn`, binding both the engine clock and the cycle's
   `clock` performer to `now`;
3. **confirms the wakeup only after a committed turn.**

That last point is the durability guarantee. A wakeup is confirmed — consumed —
only when the resumed turn actually advanced the session, i.e. committed a
`finished` or `parked` marker. Two non-committing outcomes are left alone:

- **`contended`** — the pump never acquired the lease; no turn ran, nothing was
  journaled.
- **`aborted`** — the resume lost the lease mid-flight.

In both cases the timer-park is unchanged, so the wakeup **re-fires on a later
tick**. This is **at-least-once**: consuming a wakeup on a turn that didn't commit
would orphan the session if this pump wasn't the writer. The `schedule-runner`
test exercises both: an aborted resume re-fires and then commits; a permanently
contended resume is never confirmed.

A session the pump doesn't own — `resumeInputs` returns `null` for it — is
**skipped, not confirmed**, and left due for its real owner.

The pump is deterministic given `now`. The caller owns the wall-clock loop and
decides how to advance logical time.

## Run it: `iris schedule`

```sh
iris schedule ./image --interval 10 --max-runs 3 --db sched.sqlite
```

This starts cycle 1, parks it on a durable SQLite timer, then drives the pump
forward, resuming each due cycle until the schedule finishes. It prints one JSON
line per committed cycle. The job is a keyless `echo` heartbeat pinned to the
agent image — one effect per cycle.

| Flag | Default | Meaning |
|---|---|---|
| `<layoutdir>` | — | the agent image whose digest pins the schedule's def |
| `--interval <ticks>` | `10` | logical-time units between cycles |
| `--max-runs <n>` | `3` | finish after this many runs |
| `--ticks <n>` | `max-runs` | pump steps to drive after the start cycle |
| `--db <path>` | `:memory:` | the SQLite store; a path makes it durable |
| `--session <id>` | `schedule` | the session id |

Two warnings worth knowing:

- `--db :memory:` warns — the schedule won't persist. Pass `--db <path>` for a
  durable, resumable job.
- `--ticks` below `max-runs − 1` warns — the schedule won't reach `finished`
  this run; it parks for a later resume. (Which is fine — that's the point of
  durability. The next invocation picks it up.)

## Why a parked schedule survives anything

Because a schedule is just a durable session, every property of the substrate
applies to it for free:

- **It replays identically.** The cadence is journaled, so a fresh run of the
  same config produces a byte-identical journal — the `cli-schedule` test asserts
  two independent runs match digests.
- **It survives a restart.** A parked schedule is a timer wait on disk; kill the
  process and the next pump tick resumes it where it stopped.
- **It composes.** A schedule whose `job` is a `subagent` spawn delegates to a
  child agent every cycle — the child runs in its own durable session, each
  delegation is journaled in the schedule, and the whole thing still replays. The
  `schedule-subagent-composition` test runs this end to end.

A note on that composition: the job `request` is fixed across cycles, so a
`subagent` job with a constant `callId` re-enters the **same** deterministic
child each cycle — established on the first run, replayed (not re-executed) after.
A distinct child per cycle would need a cycle-varying `callId`; that's deferred.

---

To go deeper on the substrate a schedule rides on:

- [The harness](../harness.md) — the loop and the journaled-decision idea.
- [Audit & reproducible evals](../audit-and-evals.md) — why "the journal is the
  audit," and where `iris schedule` first appears in the funnel.
