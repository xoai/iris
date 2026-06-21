# Multi-agent teams — an orchestrator and its specialists

Some work is too broad for one agent's attention. Iris lets you build a **team**:
one **orchestrator** agent that delegates slices of the job to **specialist**
child agents — a researcher, a copywriter, an editor — each a full agent with its
own durable session. We'll build a small marketing team end to end.

> This is a recipe on top of [Subagents](./subagents.md) — read that first for the
> delegation mechanics (the deterministic child id, the durability guarantee).
> Building and running single agents is [Your first agent](../first-agent.md).

## The one idea: a teammate is a tool

Iris has no peer-to-peer agent mesh, no shared blackboard, no message bus. A
"team" is simpler than that: the orchestrator's **tools are other agents**. You
list each specialist in a `subagents.json` beside the orchestrator, mapping a
delegate **tool name** to that specialist's built **image**:

```json
[
  { "name": "research", "image": "./children/researcher" },
  { "name": "write",    "image": "./children/copywriter" },
  { "name": "edit",     "image": "./children/editor" }
]
```

Now `research`, `write`, and `edit` appear to the orchestrator model as ordinary
tools. When it calls one, the kernel runs that child agent to completion in its
**own durable session** and journals the child's final output as the tool result.
That's the whole model — and it buys you three properties for free:

- **One-way and sequential.** The orchestrator drives; specialists don't talk to
  each other or call back. Coordination lives entirely in the orchestrator's
  instructions. (If you need a specialist to consult another, have the
  orchestrator make that second call.)
- **Each teammate is independently durable.** A child has its own journal and
  replays on its own; the parent replays by folding the recorded result, never
  re-running the child.
- **Off by default.** No `subagents.json` ⇒ the orchestrator is a byte-identical
  ordinary agent. The team is purely additive.

## Build the specialists

Each specialist is just an agent project. Scaffold, give it focused
instructions, and build it to an image directory:

```sh
iris init researcher
# edit researcher/instructions.md — "You research a topic and return 5 sourced bullets."
iris build --file researcher/agent.yaml --out ./marketing-team/children/researcher
```

Repeat for `copywriter` ("turn a research brief into ad copy") and `editor`
("tighten copy to ≤ 60 words, fix tone"). Each `--out` directory is a complete,
content-addressed OCI image — the unit `subagents.json` points at.

A specialist can carry its own tools, model, and skills like any agent — a
researcher might bundle a `fetch` tool, the editor none. They share the
orchestrator's store and scheduler family but run under their own derived
session ids.

## Wire the orchestrator

The orchestrator is an agent whose **job is to delegate**. Its instructions name
the delegate tools and the order to use them:

```markdown
<!-- marketing-team/instructions.md -->
You are the campaign lead. Produce finished ad copy for the requested product:

1. Call `research` with the product and audience.
2. Pass the findings to `write` to draft three copy variants.
3. Send the best variant to `edit` for a final tightening pass.

Return the edited copy plus a one-line rationale.
```

Drop the `subagents.json` above beside `marketing-team/agent.yaml`, then build:

```sh
iris build --file marketing-team/agent.yaml --out ./marketing-team/image
```

## Run the team

`iris run`, `iris serve`, and `iris chat` auto-discover a `subagents.json` beside
the image (override with `--subagents <file>`). Talk to the orchestrator and it
delegates down the chain. Start keyless — every agent falls back to a
deterministic echo model when no API key is set, so the wiring runs before you
spend a token:

```sh
iris chat ./marketing-team/image --session demo --db team.sqlite --fake
```

Then swap in a real model by setting the provider key (the orchestrator and each
child each select their provider when the matching key is present):

```sh
ANTHROPIC_API_KEY=sk-... iris chat ./marketing-team/image --session demo --db team.sqlite
```

Or put the team behind HTTP for a UI or another service to call:

```sh
ANTHROPIC_API_KEY=sk-... iris serve ./marketing-team/image --web --db team.sqlite
```

## What each delegation does, and how it can end

A delegate call drives the child to a terminal state and maps the outcome back to
the orchestrator as a normal tool observation (only genuine infra contention is a
retryable failure):

| Child outcome | The orchestrator sees |
|---|---|
| `finished` | the child's `output` — the normal case |
| `parked` | the child paused (e.g. waiting on a [human approval](./human-in-the-loop.md) or a timer) — a legitimate durable state |
| `exhausted` | the child hit its turn cap without converging — a real observation, not a fault |
| `aborted` | infra lease/seq loss — the only failure, and the only one retried |

A parked specialist is a feature: a child that needs sign-off pauses durably, the
whole team survives a restart, and the approval resumes the exact session.

## Going deeper

- [Subagents](./subagents.md) — the delegation substrate and its guarantees.
- [Autoresearch loop](./autoresearch-loop.md) — when the orchestrator delegates the
  *same* specialist repeatedly to refine an answer.
- [Automated workflow](./automated-workflow.md) — run a team unattended, on a
  schedule, deployed.

---

Related: [Subagents](./subagents.md) · [Your first agent](../first-agent.md) · [The harness](../harness.md).
