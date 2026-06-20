# The harness

Iris ships the loop between your model and your tools — tool-calling, context
compaction, error repair, human approval, and knowing when to stop. That loop is the
**harness**. It isn't a black box: it's assembled from small, swappable **tactics** at
five named **seams**, and **every decision it makes is journaled** — so you can change
how your agent thinks without giving up deterministic replay.

> You've already seen the harness at work: in [Your first agent](./first-agent.md) the
> agent called a tool and stopped on its own; in [Governance](./governance.md) it
> paused for approval. Both are tactics. Here's the machinery.

## The one idea: decisions are recorded, not re-run

Whenever the harness must decide something — *assemble the prompt? compact the
context? run this tool or ask a human first? the tool errored — retry or repair?
continue or finish?* — it consults a tactic and records the answer as a `tactic`
effect in the journal: `{ seam, tacticId, choice }`. On replay the kernel **folds the
recorded choice and never re-invokes the tactic**.

Two things fall out of that, for free:

- A tactic can be **nondeterministic or third-party** — it could even call an LLM to
  decide — and replay still can't diverge, because replay reads the recorded choice.
- You can **swap a tactic** without touching the core, and without breaking any session
  already on disk.

## The five seams

A seam is a typed decision point. A tactic plugs into exactly one — and its signature
can't reach another seam's concern (a compaction tactic literally has no access to
gating).

| Seam | Consulted | Decides |
|---|---|---|
| `assembleContext` | before a model call | the `ModelContext` to send — a **pipeline**, each tactic transforms it |
| `shouldCompact` | context may exceed budget | `false`, or the **compacted** context (the decision *is* the result) |
| `decideNext` | after a model step | `continue` · `finish` · `{ wait }` — the tool-loop control |
| `gateAction` | before a tool runs | `allow` · `ask` (human approval) · `deny` |
| `onToolError` | a tool call failed | `retry` · `repair` (apply a suggested patch) · `giveUp` |

Composition is defined, not ad-hoc: `gateAction` is **most-restrictive-wins**
(`deny` > `ask` > `allow`), `decideNext` is **first-decisive-wins** (`continue` yields
to the next tactic), and `assembleContext` is an ordered pipeline.

## The default bundle

A **bundle** is a set of tactics — one (or a chain) per seam. `"default"`, what you
get unless you say otherwise, is the ReAct tool-loop with batteries included:

| Seam | Default tactic | What it does |
|---|---|---|
| `decideNext` | `iris/react` | continue while the model is still requesting tools; finish when it stops |
| `gateAction` | `iris/approve-irreversible` | known-safe tools → `allow`; everything else (irreversible or unknown) → `ask` |
| `shouldCompact` | `iris/window-compaction` | over the token budget → keep the last *N* messages; otherwise `false` |
| `onToolError` | `iris/tool-repair` | a tool-suggested `fix` → `repair` once; else `retry` up to a cap, then `giveUp` |
| `assembleContext` | `iris/react` | passes the conversation through (a richer assembler can layer in later) |

The bundle also sets the kernel's **invariant caps** (max steps and tool-calls per
turn) — a hard floor the kernel enforces regardless of what any tactic returns.

## Configure it in the Agentfile

Choose a bundle, or override a single seam — nothing else changes:

```yaml
# agent.yaml
harness:
  bundle: default
  tactics:
    decideNext: iris/tool-loop@^1   # swap one seam; the rest stay default
```

`harness.bundle` selects the base (`"default"`, or a domain bundle). `harness.tactics`
overrides individual seams by reference — pinned by digest at build, like every other
contract in the Agentfile.

## A domain bundle: coding

`@irisrun/bundle-coding` shows what a specialized bundle looks like. It **reuses** the
default tool-loop, compaction, and tool-repair, and **changes one seam** — the gate:

- read-only / codebase-search tools (`read_file`, `search`, `list`, `grep`, `glob`) →
  `allow`;
- writes (`write_file`), shell (`run_shell`), and anything unknown → `ask` (HITL).

That's the whole pattern: compose on `@irisrun/core`'s exported tactics, override the
seam your domain cares about, and ship `{ tacticPerformer, invariants }`. The journaled
`{ seam, tacticId, choice }` makes the bundle replay-safe with **zero core changes** —
the same property holds for a bundle you write yourself.

## Going deeper

- The normative seam contract — signatures, composition, the journaled effect shape —
  is the [harness seams reference](./reference/harness-seams.md).
- Writing your own tactic or bundle — the
  [adding a tactic guide](./contributing/adding-a-tactic.md).

**Next → [Models & providers](./providers.md)**
