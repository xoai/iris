# @irisrun/provider-compat

**Own, portable, verifiable state — even across "OpenAI-compatible" endpoints.**
A conformance-verified registry that turns "OpenAI-compatible" from a loose claim
everyone makes into a **tested, replay-safe guarantee only Iris can make**.

## What it is

A model reply in Iris is a recorded journal effect that must replay
**byte-identically**. So the canonicalization layer — where divergent
"compatible" endpoints quietly differ (`finish_reason`, `usage`, streaming
terminators, IDs) — is exactly where "compatible" breaks, and the one place that
*has* to care is Iris. This package is the registry that makes the claim precise:

- `COMPAT_MATRIX` — OpenAI-protocol and Anthropic-protocol endpoints, each tagged
  **replay-safe** (point `--base-url` at it with its key and a recorded session
  replays byte-identically) or **known-divergent** (the response canonicalizes, but
  reaching it needs auth/URL/transport adaptation — Azure's `api-key` header,
  Bedrock's SigV4, Vertex's OAuth — named in `note`).
- `entriesByProtocol(p)`, `findEntry(id)` — accessors.
- `renderCompatMatrix()` — a deterministic markdown table, used by
  `iris providers --matrix` and pinned to `docs/providers.md` by a drift guard.

Every entry is run through the matching adapter in CI
(`tests/provider-compat-matrix.test.ts`) and must canonicalize to the stable
`ModelCallResult`, or be flagged here. The matrix is conformance-tested data, never
a doc that rots into a false promise.

> "Replay-safe" is faithful **capture + canonicalization** of the model's reply —
> not a claim that the endpoint is deterministic.

## Usage

```sh
iris providers --matrix     # print the rendered matrix
```

```ts
import { COMPAT_MATRIX, findEntry } from "@irisrun/provider-compat";
const groq = findEntry("groq");   // { protocol: "openai", baseUrl: "…/chat/completions", … }
```

Point a portable image at any replay-safe endpoint at deploy time:

```sh
iris serve ./image --model openai --base-url https://api.groq.com/openai/v1/chat/completions
```

---

Part of [Iris](../../README.md) — own, portable, verifiable state.
