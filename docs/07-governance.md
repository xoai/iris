# 07 — Governance & audit

The last stop is trust: who is allowed to do what, and how you prove what happened.
This is where Iris's durability substrate pays off — and it's also where some of
the story is still roadmap. This page is honest about both.

## What exists today: the approval gate

The default harness includes an **`approveIrreversible`** tactic. When the agent
tries to run an irreversible tool, the gate parks the session for human approval
*before* the effect runs. Read-only ("retry-safe") tools the project bundles are
allow-listed, so routine reads don't nag — but the irreversible floor cannot be
silently weakened.

Crucially, an approval **is itself a journaled effect**. It isn't a side note in a
log file; it's an ordered, checkpointed record in the same event-sourced journal as
every model call and tool result.

## Why the journal makes audit different

Because the journal is the source of truth and replay is deterministic, the
approval trail is **replayable and ordered by construction**:

- every approval (who/what/when, as recorded) is queryable from the journal;
- the trail is reproducible — replaying the session reproduces the exact same
  sequence of approvals and effects, byte-for-byte;
- nothing can have run "around" the record, because effects are checkpointed
  *before* they execute.

That is the raw material for a compliance-grade, reproducible audit story — and
it's a property a system without an event-sourced substrate can't easily retrofit.

## The governance layer (P1-5, landed)

The gate mechanism is now wrapped by a real **governance layer**, the `@iris/auth`
package — opt-in, with zero change to the default behavior:

- **Identity** — who an approver *is* (`Principal`: an id and roles).
- **Authorization policy** — a declarative, configurable "who may approve what"
  (`ApprovalPolicy`); an unauthorized approval is converted to a skip, not honored.
- A first-class, queryable **approval audit** over the journal (`auditApprovals`),
  reading the *full retained journal* so the trail stays complete across snapshots.

It's wired into `iris run`/`serve` as an opt-in `governance` option, so the default
(ungoverned) path is byte-identical to before. For the whole-session compliance
audit and reproducible evals built on top of this, continue to chapter 08.

## Beyond approvals: the whole-session audit

This page covered the *approval* trail. Chapter 08 turns the same substrate into a
product: a whole-session, replay-verified compliance audit (every effect, not just
approvals) and provably reproducible evals — runnable with `iris audit`.

**Next → [08 — Audit & reproducible evals](./08-audit-and-evals.md)**
