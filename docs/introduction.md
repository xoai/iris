# Introduction

Iris is a **portable runtime for durable AI agents**. You declare an agent as a
config file plus a folder (instructions, tools, skills), and `iris build` compiles
it into an open, content-addressed image — the unit you version, push to any OCI
registry, and run anywhere.

## The one idea

At runtime, a **session is an event-sourced journal**. Every model call, tool
result, and timer is checkpointed *before* it runs, so live state is a
deterministic **replay of the log**, not a process you hold open.

Two things fall out of that, for free:

- **Durable** — a crash loses nothing; a fresh process rehydrates from the journal
  and continues exactly where it stopped.
- **Portable** — because nothing lives in process memory, a session can pause on a
  VPS and resume in a serverless function or an edge isolate, mid-task and
  byte-for-byte identical — against any LLM, over any channel.

The harness ships with the runtime: tool-calling, human-in-the-loop gates, context
compaction, idempotent retries, resumable long-running work. Every decision is
journaled, so replay never diverges.

## Who it's for

Reach for Iris when an agent must **not** lose state and must **not** be welded to
one host or vendor: long-running or human-in-the-loop workflows, edge/serverless
deployments, anything where "resume exactly where it left off — somewhere else" is
a requirement rather than a nice-to-have.

If your agents are short, stateless request/response calls, you may not need a
durability runtime at all — and that's fine.

## What you'll build following this path

By the end of this funnel you will have run an agent locally with no key, given it
a tool, served it to a browser, deployed it to a real edge host, swapped its model
provider, and seen its approval audit trail — each step grounded in a real command.

For the full rationale, comparisons, and architecture, read the
[README](../README.md).

**Next → [Your first agent](./first-agent.md)**
