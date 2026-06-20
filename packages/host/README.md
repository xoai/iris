# @irisrun/host

**Same image, a different host — made explicit.** A host is just
`{name, capabilities, store, scheduler}`. Once the engine is pure and durability
lives in the journal, "run anywhere" stops being a slogan: any host that supplies
a store + scheduler can resume the same image, and a capability diff decides — at
deploy time, loudly — whether it's allowed to. Host-side; the core stays pure.

## What it is

`HostAdapter` is the four-field surface (`name`, `capabilities`, `store`,
`scheduler`). `runTurnOn(adapter, opts)` runs ONE turn on that host's store +
scheduler — a thin call into the engine's `runTurn` with the adapter's ports
injected, defaulting the writer `holderId` to the host name.

The deploy gate is two functions over an image's `CapabilityProfile`:
`diffCapabilities` returns the structured `CapabilityGap[]` (booleans like
`filesystem`/`websockets`, plus `tool_locality` ranked `remote < local <
in-process` against the host's ceiling); `assertDeployable` throws — joining every
gap's message — if the image can't run. `checkHostCapabilities` is the narrower
tool-level boolean refusal. Refuse LOUDLY, never silently degrade. Zero external
deps; depends on `@irisrun/core` + `@irisrun/agent` only.

## Use it

```ts
import { runTurnOn, assertDeployable, type HostAdapter } from "@irisrun/host";

assertDeployable(image.requires, host);        // throws naming every gap, or returns
const outcome = await runTurnOn(host, { sessionId, defDigest, program, performers, clock });
```

See **[docs/Architecture](../../docs/architecture.md)** and
**[docs/Deploy](../../docs/deploy.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
