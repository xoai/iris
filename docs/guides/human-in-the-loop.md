# Durable human-in-the-loop — approvals that wait

Some steps shouldn't run without a person's say-so: send the email, charge the
card, merge the PR. Iris lets an agent **pause** on such a step — for seconds or
for days — wait for a human decision through a channel, and resume the **exact**
session byte-for-byte. The wait costs nothing: a parked session is just a marker
on disk.

> Builds on [Governance & approvals](../governance.md) (the policy layer and the
> journaled approval trail) and [Channels](../channels.md) (how a human reaches a
> parked session). This guide is the recipe that ties them together.

## The one idea: an approval is a durable park, not a blocking call

When the agent calls a tool that isn't retry-safe, the kernel doesn't run it. It
**parks** the session on an approval signal and records the request. Nothing is
holding a connection open or a thread blocked — the session is suspended in the
store. A human (or another service) sends a decision; the gate checks it against
your policy, journals it, and the session resumes. Because the decision rides the
journal, the whole thing replays deterministically and survives any restart in
between.

That's the difference from an ordinary "are you sure?" prompt: the pause is
**durable**. Redeploy the host, reboot the box, come back tomorrow — the approval
is still pending, and answering it resumes the same session.

## Declare who may approve: a policy

A policy is a small JSON file: a list of rules and a default decision. It governs
which principals may approve which calls.

```json
// policy.json
{
  "rules": [
    { "tool": "send_email", "roles": ["editor"], "decision": "permit" },
    { "tool": "charge_card", "roles": ["finance"], "decision": "permit" }
  ],
  "default": "deny"
}
```

`default: "deny"` is the safe floor — a call no rule permits is refused. Load it
on whichever surface serves the agent:

```sh
iris serve ./image --policy policy.json --db approvals.sqlite
```

## Approve from the terminal

`iris chat` runs the gate inline. Pass the approver's identity and roles; when the
agent hits a gated tool, you're prompted, and the journaled approval carries *who*
decided:

```sh
iris chat ./image --session s1 --db approvals.sqlite \
  --as alice --role editor --policy policy.json
# … agent calls send_email → approve? [y/n]
```

## Approve over a channel (REST, or Slack)

Behind `iris serve`, a parked approval is answered by posting the decision to the
session — the principal, the call, and the intent:

```json
{ "approve": { "callId": "c1", "name": "send_email",
               "principal": { "id": "alice", "roles": ["editor"] },
               "intent": "approve" } }
```

For approvals that may wait hours, wire the **Slack channel**
(`@irisrun/channel-slack`). Its trick is exactly the durability story: the
approval context rides the **signed Slack button value**, and the durable session
is the journal — so a teammate can click *Approve* long after the original
request, even across a redeploy, and the right session resumes. Signatures are
verified in constant time. (For Discord / Telegram / Teams, the same shape is an
external [bridge](../reference/bridge-pattern.md).)

## Every decision is on the record

Because approvals are journaled, the trail is auditable after the fact — who
approved what, when, and whether the session replays consistently:

```sh
iris audit s1 --db approvals.sqlite --json
```

That's the compliance payoff: not just that the agent paused, but a
replay-verified record of the human decision that let it continue.

## Where this fits

A human gate composes with everything else: a [specialist in a team](./multi-agent-team.md)
can park for sign-off (the orchestrator sees `parked`, the team survives), and an
[unattended workflow](./automated-workflow.md) can stop for approval mid-pipeline
without losing the run.

## Going deeper

- [Governance & approvals](../governance.md) — the policy model and the approval
  trail in depth.
- [Channels](../channels.md) — the session protocol a human reaches in through.
- [Audit & reproducible evals](../audit-and-evals.md) — verifying the trail.

---

Related: [Governance & approvals](../governance.md) · [Channels](../channels.md) · [Audit](../audit-and-evals.md).
