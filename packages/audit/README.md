# @irisrun/audit

**Compliance-grade audit, straight from the journal.** Because every effect,
marker, and approval is recorded in a deterministic, event-sourced journal, "what
happened" isn't a log you hope is complete — it's a **replay-verifiable record**.
No separate audit log to fall out of sync.

## What it is

A read-only projection over the existing journal (**zero kernel change**).
`auditSession` produces a whole-session, compliance-grade trail over the *full*
retained journal with a completeness check; `verifyReplay` / `verifySession`
re-derive the session from its journal and assert structural integrity +
in-process replay-determinism + totality; `renderAudit` formats the trail. This
verifies **faithful record-replay** of captured effects — it does not make the
model deterministic. Depends on `@irisrun/core` + `@irisrun/auth` only.

## Use it

```sh
iris audit s1 --db /tmp/s1.sqlite    # a replay-verified, compliance-grade trail for session s1
```

See **[docs/08 — Audit & reproducible evals](../../docs/08-audit-and-evals.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
