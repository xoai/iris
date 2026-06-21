# Architecture

Iris is ~31 packages, but the shape is one idea: a **pure core** that owns durability,
and **host adapters** behind two narrow ports. Everything else is a layer around that
spine. This page is the map a contributor needs before changing anything.

## The one idea: pure core, two ports

`@irisrun/core` is the whole durability engine — the event-sourced journal, the
deterministic replay (with the always-on consistency assertion), the effect engine,
lease/fencing, crash recovery, snapshots, session pinning, and the harness kernel. It is
**pure**: it imports nothing host-, transport-, or Node-specific (enforced — see
[conventions](./conventions.md)), so the same bytes run on a VPS, a serverless function,
or an edge isolate.

The core reaches the outside world through exactly **two ports** (`packages/core/src/ports.ts`):

| Port | What it abstracts | Key methods |
|---|---|---|
| `StateStore` | durable bytes — the journal + snapshots + the single-writer lease | `append` (atomic, dense, **fenced**), `readJournal`, `cas`, `writeSnapshot` / `readLatestSnapshot` / `truncateJournal` |
| `Scheduler` | durable time + external events | `sleepUntil` (durable timer), `waitForSignal`, `signal` |

A host adapter is anything that implements those two. `append` is the load-bearing
contract: the fence check, the expected-seq check, and the insert must be **one atomic
operation** — that's what makes at-least-once + single-writer safe across crashes.
`Version` is the monotonic fencing token.

## The layers

```
                        ┌──────────────────────────────┐
   author/build  ──────►│  @irisrun/agent  (Agentfile → content-addressed image)
                        └──────────────┬───────────────┘
                                       ▼
   tools / sandbox ──►  @irisrun/core  ◄── harness (seams · tactics · bundles)
        (referenced)     pure engine        @irisrun/bundle-coding
                        StateStore │ Scheduler
            ┌──────────────────────┼───────────────────────┐
            ▼                      ▼                        ▼
   store-sqlite / store-fs    channels (one port)      providers (one port)
   store-memory / store-do    rest · mcp · slack       anthropic · openai
   + @irisrun/host            web · client-sdk         + provider-compat
            │
            ▼
   read-only derivations:  audit · inspect · observe · evals · journal-export
   governance:             @irisrun/auth        CLI:  iris-runtime
```

### Core & host
- **`@irisrun/core`** — the pure engine + the two ports + the harness kernel/seams/`defaultBundle`.
- **`@irisrun/host`** — `HostAdapter` (`{name, capabilities, store, scheduler}`), `runTurnOn`, and the capability-diff deploy gate.
- **Host adapters** (implement `StateStore` + `Scheduler`): `store-sqlite` (long-running), `store-fs` (serverless, O_EXCL), `store-memory` (in-memory), `store-do` (edge / Durable Objects). They pass one **cross-store conformance** harness (`tests/lib/cross-store-program.ts`).

### The agent image
- **`@irisrun/agent`** — the image toolchain: Agentfile parse/validate, resolve/embed/pin, deterministic `imageDigest`, OCI layout, loud `verify`, session pinning + definition migration.

### Tools
- **`@irisrun/tools`** — the tool boundary: `ToolContract` + digest, the uniform invoker, the in-process / subprocess / MCP / gRPC transports, the `tool_call` performer. Tools are referenced by address, never embedded.
- **`@irisrun/sandbox`** — the security floor: deny-all network + credential brokering + a host-side egress proxy.

### Channels (one port)
- **`@irisrun/channel-core`** — the channel **port** + the conformance suite every channel passes (`tests/lib/channel-port-conformance.ts`).
- **`channel-rest` · `channel-mcp` · `channel-slack`** — three channels behind that one port; **`channel-web` + `client-sdk`** put a human in front.

### Providers (one port)
- **`provider-anthropic` · `provider-openai`** — model adapters behind one tested port (`tests/lib/model-provider-conformance.ts`); **`provider-compat`** is the conformance-verified compatibility matrix.

### Harness bundles
- **`@irisrun/bundle-coding`** — a domain tactic bundle composed on core's exported tactics (see [the harness](./harness.md)).

### Derivations & governance (read-only over the journal)
- **`audit` · `inspect` · `observe` · `evals` · `journal-export`** — pure projections of the journal (compliance trail, decision timeline, OTel spans, reproducible evals, the verifiable export). **`@irisrun/auth`** adds the journaled approval policy. None of them can perturb replay.

### CLI
- **`iris-runtime`** — the `iris` binary over all of the above; commands are unit-testable with injected deps. See the [CLI reference](./reference/cli.md).

## Where the boundary is enforced

The "core is pure" rule isn't a guideline — `tests/lib/scan-imports.ts` statically scans
`@irisrun/core` and fails if any source imports a non-relative specifier (a `node:`
builtin, a host/transport package, or any dependency). That single rule is what keeps the
durability engine edge- and WASM-reachable. The house rules that follow from it are in
[conventions](./conventions.md).

---

Related: [the harness](./harness.md) (the kernel's extension model) ·
[conventions](./conventions.md) (the rules this shape enforces) ·
[CONTRIBUTING](../CONTRIBUTING.md) (the dev loop).
