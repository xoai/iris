# Auditable agent — prove what it did

When an agent acts on something that matters, "trust me" isn't enough. Iris turns
every session into a **replay-verified, tamper-evident record** — from the *same*
journal that ran the agent, so there's nothing separate to keep in sync and
nothing to forge after the fact. This guide is the recipe for an agent whose every
run a stranger can re-check.

> Builds on [Audit & reproducible evals](../audit-and-evals.md) (the audit model),
> [Governance & approvals](../governance.md) (the approval trail), and
> [Verifiable portable journals](../verifiable-journal.md) (portable proof).

## The one idea: the journal is the audit

There's no separate audit log to trust. The journal that *is* the session — every
decision, effect, and outcome — is the audit trail. `iris audit` reads it back,
replay-verifies it, and renders a compliance-grade summary:

```sh
iris audit s1 --db agent.sqlite            # human-readable trail + verdict
iris audit s1 --db agent.sqlite --json     # structured, for a pipeline
```

You get the typed sequence of what happened (effects, results, approvals) plus a
**replay verdict**: does the recorded journal re-fold to a consistent state, with a
dense sequence and no structural holes.

## It never lies about completeness

A truncated history is the dangerous case — an audit that silently drops the
inconvenient part is worse than none. Iris won't: an audit is reported **COMPLETE**
only when the journal goes back to sequence 0. If history was truncated (after a
snapshot), it says **PARTIAL — truncated before #N**, loudly, and tells you how to
retain full history. The audit either covers everything or admits it doesn't.

## Who approved what

If the agent runs under [governance](../governance.md), human approvals are part of
that same journal — so the audit shows not just *that* a risky tool ran, but the
journaled decision that permitted it: the principal, the intent, the moment.
Run the agent with a policy, and the approval trail audits itself:

```sh
iris serve ./image --policy policy.json --db agent.sqlite
# … later …
iris audit s1 --db agent.sqlite --json     # the approval decisions are in the record
```

## Portable proof a stranger can re-run

The strongest claim isn't "audit it on my machine" — it's "here's the file,
verify it on yours." Export the session to a content-addressed `*.irisjournal` and
anyone can check it with nothing but the file (and re-fold it against the image):

```sh
iris journal export s1 --store agent.sqlite --out s1.irisjournal
iris journal verify s1.irisjournal --replay --image ./image --json
```

`verify` detects tampering, reordering, and truncation by content address, and
`--replay` proves the journal reproduces the state it claims. What verification
does **and doesn't** assert is spelled out in the
[journal threat model](../reference/threat-model.md) — read it before you lean on
the guarantee; honest scope is the point.

## Prove it's reproducible, not just recorded

For behavior you need to defend over time, pair the audit with a reproducible
[eval](./autoresearch-loop.md#set-up-an-eval-for-the-loop): `iris eval suite.mjs
--reproduce N` runs a deterministic scenario N times and asserts a byte-identical
score and journal digest. An audit says *what this run did*; a reproducible eval
says *the agent does the same thing every time* — together they're a claim you can
stand behind.

## Going deeper

- [Audit & reproducible evals](../audit-and-evals.md) — the full model: what
  `verify` proves, COMPLETE vs PARTIAL, and the eval arbiter.
- [Governance & approvals](../governance.md) — the policy layer behind the
  approval trail.
- [Verifiable portable journals](../verifiable-journal.md) — the portable proof
  format.

---

Related: [Audit & reproducible evals](../audit-and-evals.md) · [Governance](../governance.md) · [Verifiable portable journals](../verifiable-journal.md).
