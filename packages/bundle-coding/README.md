# @irisrun/bundle-coding

**The first domain tactic bundle — proof the harness is pluggable.** A
coding-specialized bundle composed entirely from `@irisrun/core`'s exported
tactic primitives, returning the **same** `{tacticPerformer, invariants}` shape
as the default bundle — so core stays byte-untouched and the replay quarantine
applies unchanged. `@irisrun/core` is the only dependency; this is not a
host/transport package.

## What it is

`codingBundle(opts)` assembles the five harness seams the way a coding agent
wants them: read-only / codebase-search tools (`read_file`, `search`, `list`,
`grep`, `glob`) are a safe **allow**, while writes (`write_file`), shell
(`run_shell`), and anything unknown are gated to **ask** (HITL) — the
gate-irreversible-by-default floor, implemented in `codingGate`. `codingDecideNext`
delegates verbatim to core's proven ReAct tool-loop (a distinct factory kept so a
future coding heuristic can layer in without touching core). Window-compaction and
tool-repair are reused from core as-is. The journaled `{seam, tacticId, choice}`
outcome rides the `tactic` effect exactly like `defaultBundle`, so replay folds the
recorded choice and never re-invokes the tactic. `BUNDLE_ID` (`iris/coding`) is the
stable id pinned into `Lock.tactics.bundle`.

## Use it

```yaml
# agent.yaml
harness:
  bundle: iris/coding
```

See **[docs/The harness](../../docs/harness.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
