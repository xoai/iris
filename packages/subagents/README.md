# @irisrun/subagents

**Durable, replayable delegation.** When an agent delegates a sub-task, the child
runs in its *own* durable session and journal; the child's final output is
recorded in the parent as the delegating effect's result — so the parent replays
deterministically **without ever re-running the child**, while the child replays
independently.

## What it is

Wires the `subagent` effect kind via a host-side performer.
`makeSubagentPerformer` answers a delegation effect by driving a child agent to
completion (`driveToCompletion`, bounded by `DEFAULT_MAX_TURNS`) and journaling
its result in the parent. Pure breadth on the existing journaled substrate —
depends on `@irisrun/core` + `@irisrun/host` only, no kernel change.

## Use it

Register `makeSubagentPerformer` as the host's `subagent` performer (the CLI wires
it from a project's `subagents.json`).

See **[docs/Audit & reproducible evals](../../docs/audit-and-evals.md)**
for delegation on the journaled substrate.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
