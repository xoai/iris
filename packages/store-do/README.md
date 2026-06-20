# @irisrun/store-do

**The edge host that proves portability.** A Cloudflare Durable Objects adapter
that enforces the **same** CAS / fencing / high-water-mark / snapshot invariants
as the sqlite and filesystem stores — the invariants that make replay
byte-identical — so the same image resumes the same session on the edge by
construction (verified against a `FakeDoStorage`; the live isolate is an
env-gated manual smoke). Owning your state as a portable journal is what makes
"run anywhere" real; this is the *anywhere*.

## What it is

`DoStateStore` + `DoScheduler` implement the two ports over a narrow `DoStorage`
abstraction — a cold-per-turn isolate with a DO-alarm-backed durable timer
(`sleepUntil`); `edgeHost` wires them as a `HostAdapter`. Install-free: tested
against a `FakeDoStorage`, with the real isolate as an env-gated manual smoke. No
`@cloudflare/*` import — the same `@irisrun/core` runs unchanged on the edge.

## Use it

```sh
iris deploy ./image --out ./iris-edge    # scaffold a Worker + Durable Object
```

See **[docs/05 — Deploy](../../docs/05-deploy.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
