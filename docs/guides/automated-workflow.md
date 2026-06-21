# Automated workflows — run a multi-agent pipeline unattended

A workflow is a [team](./multi-agent-team.md) that runs without you watching it:
an orchestrator delegates a fixed pipeline — research → draft → review — and the
whole thing runs on a schedule, survives restarts, and resumes mid-pipeline if
the box reboots. This guide assembles that pipeline and deploys it **two ways**:
to Cloudflare Durable Objects, or self-hosted on any VPS.

> Builds on [Subagents](./subagents.md) (the pipeline stages),
> [Schedules](./schedules.md) (unattended cadence), and [Deploy](../deploy.md)
> (the edge target). Read those for the primitives.

## The one idea: a workflow is a durable session that drives a pipeline

Nothing new is needed. The pipeline is an orchestrator with a `subagents.json`
listing its stages; "unattended" is a [schedule](./schedules.md) that wakes the
orchestrator on a timer; "survives restarts" is the journal. Because cadence and
every delegation are journaled, the workflow replays byte-for-byte and a crash
between *draft* and *review* resumes at *review*, not from the top.

```json
// subagents.json — the pipeline stages
[
  { "name": "research", "image": "./children/researcher" },
  { "name": "draft",    "image": "./children/writer" },
  { "name": "review",   "image": "./children/reviewer" }
]
```

The orchestrator's instructions encode the sequence (call `research`, feed it to
`draft`, send that to `review`, publish). Build it into an image the same way as
any agent:

```sh
iris build --file workflow/agent.yaml --out ./workflow/image
```

Run it on a cadence locally first — keyless, durable on disk:

```sh
iris schedule ./workflow/image --interval 60 --max-runs 24 --db workflow.sqlite
```

`--interval` is logical time between cycles, `--max-runs` bounds the run, and
`--db <path>` makes it resumable (an in-memory store warns — it won't persist).
Kill it mid-run and the next invocation picks up the parked schedule.

---

Now ship it. Pick the target that matches how hands-off you need to be.

## Option A — Cloudflare Durable Objects (serverless, alarm-driven)

`iris deploy` turns the image into a Cloudflare Worker + Durable Object project.
The DO's **alarm** is what drives the schedule's timer waits — no process to keep
alive; the platform wakes the workflow when the next cycle is due.

```sh
iris deploy ./workflow/image --out ./workflow-edge --name content-workflow
```

This first runs a **capability-diff gate**: the edge profile is deliberately
narrow — no subprocess, no filesystem, no held WebSockets, remote tools only — so
an image that needs more is **refused loudly**, naming the gap, before anything is
written. If it passes, you get a `wrangler.toml` and a `worker.mjs` that runs the
**same `@irisrun/core`** unchanged on the isolate.

Scaffold-only by default; the network deploy is gated (you bring a Cloudflare
account + `wrangler`):

```sh
cd workflow-edge && wrangler deploy          # or: iris deploy ./workflow/image --deploy
# set the provider key as a Worker secret, e.g. wrangler secret put ANTHROPIC_API_KEY
```

Use this when you want zero servers and the workflow is mostly idle between
timer-driven cycles.

## Option B — self-host on a VPS (full Node host, you own the process)

Iris is install-free Node 24, so any VPS runs it directly — and here a workflow
can use **subprocess and filesystem tools** the edge profile forbids. There's no
`iris deploy` target for this (and Iris ships no Dockerfile); you run the CLI as a
long-lived process and keep the SQLite store on a persistent volume.

The always-on shape is `iris serve` — a durable HTTP host you trigger over REST
(or via a cron hitting the endpoint); pair it with `iris schedule` for periodic
batches. A minimal container is a thin wrapper **you** write:

```dockerfile
# Dockerfile — you author this; Iris doesn't ship one
FROM node:24-slim
WORKDIR /agent
RUN npm i -g iris-runtime
COPY ./workflow/image ./image
VOLUME /data                       # keep the journal on a persistent volume
ENV IRIS_MODEL_BASE_URL=""         # optional: point at any compatible endpoint
CMD ["iris", "serve", "./image", "--host", "0.0.0.0", "--port", "8787", \
     "--db", "/data/workflow.sqlite"]
```

```sh
docker build -t content-workflow .
docker run -d -p 8787:8787 -v wf-data:/data \
  -e ANTHROPIC_API_KEY=sk-... content-workflow
```

Bare-metal is the same without the wrapper — run `iris serve … --db /var/lib/iris/workflow.sqlite`
under systemd (or `iris schedule …` for a timer-driven batch), and point a system
cron or timer at it. The store on disk is the durability; restart the process and
the workflow resumes from the journal.

## Which target

| | Cloudflare DO (`iris deploy`) | Self-host VPS (`iris serve` / `iris schedule`) |
|---|---|---|
| Cadence driver | DO **alarm** wakes due cycles | your process + `--interval`, or system cron |
| Tools allowed | remote (MCP) only | subprocess · filesystem · remote — full |
| You manage | nothing between cycles | the process, the volume, restarts |
| Best for | mostly-idle, timer-driven, zero-ops | tool-heavy pipelines, full control |
| Durability | DO storage | SQLite on a persistent volume |

Both run the identical image and the identical journal — you can build and test
the workflow with `--fake`, then deploy it to either without changing the agent.

## Going deeper

- [Deploy](../deploy.md) — the one-command edge path and the portability story.
- [Schedules](./schedules.md) — the cadence substrate (journaled clock, the pump).
- [Human-in-the-loop](./human-in-the-loop.md) — pause an unattended workflow for a
  human sign-off without losing the run.

---

Related: [Multi-agent teams](./multi-agent-team.md) · [Schedules](./schedules.md) · [Deploy](../deploy.md).
