# @irisrun/evals

**Reproducible evals — because determinism makes scoring repeatable.** Run the
same scenario and it replays **byte-identically** from its journal, so a score is
a fact about the run, not a roll of the dice. The arbiter is reproducibility, not
taste: the same case + scorer re-runs identically; a swapped tactic scores
differently, but reproducibly.

## What it is

`runEval` runs a deterministic scenario (a fresh store + scripted performers per
run) on the core `runTurn`, then scores the recorded session via
`@irisrun/inspect`; `runSuite` runs a set; `reproduce` re-runs a case to confirm
byte-identical replay. This is faithful record-replay of captured effects — not a
claim that a live model is deterministic. Depends on `@irisrun/core` +
`@irisrun/inspect`.

## Use it

```sh
iris eval ./evals/suite.mjs    # reproducible scenario scoring
```

See **[docs/08 — Audit & reproducible evals](../../docs/08-audit-and-evals.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
