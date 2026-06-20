# @irisrun/agent

**The image toolchain that makes an agent a build artifact.** Parse an Agentfile,
resolve + embed + pin every contract by hash, and emit a content-addressed,
deterministic image — identical inputs produce an identical `imageDigest` — so a
session resumes from exactly the definition it was born under. This is the
library behind the `iris` CLI; host-side, zero external deps.

## What it is

`parseAgentfileYaml` / `parseAgentfileJson` + `validateAgentfile` turn an
Agentfile into a checked model. `buildImage` resolves and pins each tool/bundle
contract, embeds content by hash, validates the capability profile, and computes
`imageDigest = sha256(canonicalize(image-minus-digest))` — the canonical image
excludes its own self-referential digest, so the digest is reproducible
(`computeImageDigest`, `canonicalImageOf`). `writeOciLayout` / `readOciLayout`
serialize the image as a local, files-only OCI layout. `verifyImage` re-checks
every content hash, re-resolves every contract, and recomputes the digest —
throwing **loudly** on any drift, never silently. `latestRecord`,
`governingDigest`, and `migrateDefinition` pin a session to its image digest and
migrate a live session `from`→`to` at a turn boundary, with **zero** engine change.

## Use it

```sh
iris build --file ./my-agent/agent.yaml --out ./image
iris inspect ./image
iris verify  ./image
```

See **[docs/Your first agent](../../docs/first-agent.md)** and
**[docs/Architecture](../../docs/architecture.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
