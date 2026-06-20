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

## Turn it on from the CLI: `iris serve --policy`

You don't have to write code to use it. Point `iris serve` at a policy file:

```sh
iris serve ./image --policy policy.json
```

`policy.json` is the `ApprovalPolicy` — who may approve what (an empty `rules` with
`"default":"deny"` denies everyone; a rule grants by role or principal id):

```json
{ "rules": [{ "tool": "rm", "anyOfRoles": ["admin"] }], "default": "deny" }
```

When the agent reaches an irreversible tool, the session parks on a HITL approval.
A client submits the decision as a field on the **next message body** — no extra
endpoint, the decision rides the protocol you already use:

```json
{ "approve": { "callId": "<from the parked wait>", "name": "rm",
               "principal": { "id": "alice", "roles": ["admin"] }, "intent": "approve" } }
```

The decision is policy-checked, identity-stamped, and journaled; an unauthorized or
denied approval skips the tool rather than honoring it. Every decision then appears
in `iris audit` (chapter 08) as part of the replayable approval trail. Omit
`--policy` and serve is ungoverned — byte-identical to before.

## In-chat approvals: `iris chat`

The same gate works inline in the terminal REPL. When the agent calls a non-safe
tool, `iris chat` pauses and asks you to decide — right there in the conversation:

```text
⚠️ approval needed — the agent wants to run tool 'rm' (call c1) with args {"path":"/tmp/a"}
approve? [y/n] y
· approved — running the tool (approved by 'local')
agent> done
```

Reply `y` (approve) or `n` (deny); the session resumes on the same durable journal —
running the tool on approve, skipping it on deny. Because the local terminal user is
the human-in-the-loop, no policy file is required (an approve just runs the tool).
Add identity-checked governance the same way as serve:

```sh
iris chat ./image --session s1 --db s1.sqlite --policy policy.json --as alice --role admin
```

`--as`/`--role` set the approving principal (repeat `--role` for several roles). The
decision is the *same* journaled `GovernedApproval` serve produces, so a chat session's
approvals show up in `iris audit` (chapter 08) too. Leaving an approval pending and
exiting keeps the session parked — resume later (chat or serve) to decide; nothing is
auto-approved.

## Beyond approvals: the whole-session audit

This page covered the *approval* trail. Chapter 08 turns the same substrate into a
product: a whole-session, replay-verified compliance audit (every effect, not just
approvals) and provably reproducible evals — runnable with `iris audit`.

**Next → [08 — Audit & reproducible evals](./08-audit-and-evals.md)**
