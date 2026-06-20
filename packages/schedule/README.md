# @irisrun/schedule

**Durable timers you own.** A recurring job *is* a durable, replayable agent
session: each cycle reads the logical clock, runs its job effect, and parks on a
durable timer until the next run. The cadence lives in the journal, so the whole
schedule replays identically — owned by your state store, not a host's cron.

## What it is

`scheduleProgram` defines the recurring program; `makeScheduleRunner` builds a
host-side multi-session pump that discovers due sessions via the scheduler's
`dueWakeups`, resumes them, and confirms a wakeup **only after a committed turn**
(at-least-once). Depends on `@irisrun/core` + `@irisrun/host` only.

## Use it

```sh
iris schedule ./image --interval 10 --max-runs 3 --db /tmp/sched.sqlite    # recurring jobs on the journaled substrate
```

See **[docs/08 — Audit & reproducible evals](../../docs/08-audit-and-evals.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
