# @irisrun/auth

**A journaled, replayable approval audit you own.** Identity, a declarative
who-may-approve policy on the existing human-in-the-loop gate, and every approval
decision recorded in the *same* event log as model calls and tool effects — not a
side log — so the approval trail replays and verifies straight from the journal.

## What it is

Pure governance over the existing approval gate (**zero kernel change**): it
enriches the journaled `signal_recv` approval value. `authorize` evaluates the
who-may-approve policy; `createApprovalInbox` + `makeGovernedApprovalPerformer`
answer a gated tool call from that decision; `approvalAudit` / `auditApprovals` /
`renderApprovalAudit` derive the queryable, replay-verified trail. Depends on
`@irisrun/core` + `@irisrun/inspect` only.

## Use it

```sh
iris serve ./image --policy ./policy.json    # turn on governed approvals
```

`iris chat` resolves the same gate inline. See **[docs/Governance &
audit](../../docs/governance.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
