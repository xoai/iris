# Subagents — durable delegation

A long task is easier when an agent can hand a slice of it to another agent.
Iris lets a parent agent **delegate** a sub-task to a **child** agent — and the
child isn't a function call that runs inline. It's a full agent with its **own
durable session and journal**. The parent records only the child's *final
output* as the result of the delegating tool call, so the parent replays
without ever re-running the child. The child replays on its own.

> This is the same journaled substrate as everything else. If you haven't met
> it yet, read [the harness](../harness.md) and
> [audit & reproducible evals](../audit-and-evals.md) first — delegation is one
> more effect riding that journal.

## The one idea: the child's output is journaled in the parent

When the parent model calls a delegate tool, the kernel emits a `subagent`
effect instead of an ordinary `tool_call`. A host-side performer drives the
child agent to a terminal state and returns its final output. That output is
written to the parent's journal as the delegating effect's **result** —
exactly like any other tool result.

Two things fall out of that, for free:

- The parent **replays deterministically without re-running the child**.
  Replay folds the recorded result; performers are never called on replay. The
  child model could be nondeterministic, call an LLM, take minutes — none of it
  matters to parent replay, because the answer is already on disk.
- The child is **its own durable session**, so it replays *independently* —
  its journal reduces to a finished state on its own, with no parent in the
  loop.

The delegation integration test pins both: the child model runs **exactly
once**, re-running the parent turn does not re-drive the child, and the child's
journal replays to `phase: "done"` by itself
(`tests/subagents-delegation-integration.test.ts`).

## The deterministic child-session id

Recovery is the hard case. If the host crashes after the child finished but
before the parent committed the result, recovery must re-perform the
delegation — and it must **not** spawn a second child or run the child model
again.

What makes that safe is a **deterministic child-session id**. The child's
sessionId is derived purely from the parent session and the delegating call's
id:

```
childSessionId(parentSessionId, callId) → `${parentSessionId}::sub::${callId}`
```

The `callId` is the journaled, replay-stable `ToolCall.callId`, so the same
delegation always derives the same id. A recovery re-perform re-finds the
**same** child session, which replays its existing journal (no new model call)
and returns the same already-final output. Delegation is idempotent under crash
recovery (`packages/subagents/src/id.ts`).

The id is a pure function — no I/O — and it rejects empty inputs loudly. The
guard tests assert the byte-exact format and that distinct parents or callIds
never collide (`tests/subagents-child-id.test.ts`):

```
childSessionId("parent-1", "a") === "parent-1::sub::a"
childSessionId("parent-1", "a") !== childSessionId("parent-2", "a")
childSessionId("parent-1", "a") !== childSessionId("parent-1", "b")
```

The `::sub::` delimiter can't collide with a channel-minted sessionId (those are
UUIDs), and every store keys sessions by opaque string — so no sanitization is
needed.

## How a delegation runs

`makeSubagentPerformer` is the host-side performer for the `subagent` effect. On
each delegating call it:

1. Derives the child sessionId from the parent session + the call's `callId`.
2. Resolves the child agent via `resolveChild`. Returning `null` **refuses** the
   delegation (an unknown child agent) → a clean `{ ok: false, unknown_subagent }`.
3. Drives the child to completion with `driveToCompletion`.
4. Maps the child's outcome back to the parent's effect result.

`driveToCompletion` runs the child's turns on its host until the child reaches a
terminal state, with four outcomes (`packages/subagents/src/drive.ts`):

| Outcome | Meaning | Result to the parent |
|---|---|---|
| `finished` | the child finished | `{ ok: true }` with the child's `output` |
| `parked` | the child chose to park (HITL / timer / user / signal) | `{ ok: true }`, `status: "parked"` with the wait — parking is a legitimate durable state, not force-driven |
| `exhausted` | `maxTurns` elapsed without converging (default `64`) | `{ ok: true }`, `status: "exhausted"` — the child *ran* but didn't converge; a normal observation, not a fault to retry |
| `aborted` | an infra lease/seq loss | `{ ok: false, subagent_aborted }` — the **only** failure, and the only outcome the parent's tool-error seam retries |

That mapping is deliberate. The `subagent` effect rides the kernel's
`tool_exec` phase, which has a failure handler (`tool_error`). So every
*expected* outcome — finished, parked, exhausted — is absorbed to `{ ok: true }`
and the parent model reads it as a normal observation. Only genuine infra
contention (`aborted`) is `{ ok: false }`, which the tool-error seam can retry.
The performer never returns a failure the kernel can't handle
(`packages/subagents/src/performer.ts`).

A not-yet-created child is created lazily by its first turn (an empty journal
reduces to the program's initial state), so a fresh delegation runs from the
start and a recovery re-perform replays an already-finished child to the same
output.

## Configure it: `subagents.json`

Delegation is **off by default** — an agent with no subagents config is
byte-for-byte identical to one that never had the feature. You turn it on by
declaring children in a `subagents.json` file beside the agent project: a JSON
array mapping a delegate tool **name** to a child **image**.

```json
[{ "name": "delegate", "image": "./children/researcher" }]
```

- `name` is the delegate tool name the parent model calls. A tool name listed
  here is dispatched by the kernel as a `subagent` effect; names must be unique.
- `image` is the child agent's OCI layout dir, resolved relative to the
  `subagents.json` file (or absolute).

A missing file yields an empty config — agents without subagents stay valid.
`loadSubagents` validates loudly: a non-array, a missing `name` or `image`, or a
duplicate name each throws with a pointed message
(`packages/cli/src/subagents-cfg.ts`).

`iris run`, `iris serve`, and `iris chat` pick it up automatically. The default
is `subagents.json` beside the layout; `--subagents <file>` overrides the path.
When the config is empty, no `subagent` performer is wired and no `subagentTools`
are passed — the zero-value-off guarantee
(`packages/cli/src/cli-main.ts`).

For each declared child the CLI pre-loads its image, selects its provider when
the matching API key is present (else a keyless echo model so a delegation still
runs), and wires its bundled tools. The child shares the parent's store and
scheduler family but runs under its own derived sessionId.

## Per-child model, endpoint, and key

By default a child runs **its own image's** model id, at the provider's **default
endpoint**, with the provider's **standard key** (`ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`). Three optional fields let each child override that — so a
single run can mix providers, endpoints, and keys:

| Field | Overrides | Default |
|---|---|---|
| `model` | the child's model id (keep the `anthropic/` \| `openai/` prefix — it selects the protocol) | the image's `lock.model.id` |
| `baseUrl` | the endpoint this child posts to (the deploy-time knob, per child) | the provider's default URL |
| `apiKeyEnv` | the env var holding this child's key | the provider's standard key |

A heterogeneous team — an Anthropic PM that delegates to a Kimi engineer on
Moonshot's OpenAI-protocol endpoint and a GPT QC:

```json
[
  { "name": "pm",       "image": "./children/pm" },
  { "name": "engineer", "image": "./children/engineer",
    "model": "openai/kimi-k2", "baseUrl": "https://api.moonshot.ai/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
  { "name": "qc",       "image": "./children/qc", "model": "openai/gpt-5.5" }
]
```

Here `engineer` rides the **OpenAI protocol** (`openai/` prefix) but reaches
Moonshot via `baseUrl` and authenticates with `MOONSHOT_API_KEY` — no new provider
prefix needed. A child whose `apiKeyEnv` is unset in the environment falls back to
the keyless echo model (the delegation still runs), exactly as the top-level
keyless path does. Each field, when present, must be a non-empty string or
`loadSubagents` throws (`resolveChildModel`, `packages/cli/src/child-model.ts`).

## The byte-identity guarantee

The harness kernel is golden-pinned and edited across many worktrees, so the
subagent branch **must** be inert unless it's explicitly switched on. The
load-bearing guard asserts exactly that: with `subagentTools` absent, empty, or
non-matching, the committed journal is **byte-for-byte identical** to today's
ordinary `tool_call` path. Only a tool name that *matches* a declared subagent
flips the `tool_exec` step to emit a `subagent` effect
(`tests/subagents-kernel-byte-identity.test.ts`).

The same property holds end-to-end at the CLI: `subagentPerformers(undefined, …)`
adds no `subagent` key, and a `delegate` call with no config is just an ordinary
(gated) tool call (`tests/cli-subagents.test.ts`).

---

Delegation is durable because the journal is. To see how that journal becomes a
replayable, auditable record, read [audit & reproducible evals](../audit-and-evals.md);
for the loop the child and parent both run on, [the harness](../harness.md).
