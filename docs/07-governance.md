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

## What is NOT built yet (roadmap)

The **gate mechanism** exists; a full **governance layer** does not. Specifically,
these are on the roadmap (item P1-5) and are *not* implemented today:

- **Identity** — who an approver *is*.
- **Authorization policy** — configurable "who may approve what."
- A first-class, queryable **approval audit API** over the journal.

Today, *that an approval happened* is journaled; *who was authorized to give it* is
not yet policy-controlled. Don't represent Iris as having configurable approval
governance until P1-5 lands. See the project roadmap
(`.sage/docs/adoption-roadmap.md`) for the plan and sequencing.

## You've reached the end of the funnel

If you followed every page, you have: scaffolded an agent, given it a tool, served
it to a browser, deployed it to a real edge host, swapped its model provider, and
inspected its approval trail — the path from `npx iris init` to a deployed,
talkable, audit-bearing agent.

**Next → [Back to the funnel index](./README.md)**
