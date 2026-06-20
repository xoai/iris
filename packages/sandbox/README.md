# @irisrun/sandbox

**The security floor: deny-all by default, secrets that never enter the box.**
Untrusted tool code runs inside a `SandboxSession` rooted at `/workspace` with a
deny-all network floor; egress is allowlisted per host and named credentials are
brokered *at the boundary* — the secret is injected into the outbound request as
it leaves, so only the marker name ever crosses into the sandbox.

## What it is

`SandboxBackend` / `SandboxSession` are the boundary: `run`, `readFile` /
`writeFile` (rooted at `/workspace`; a path outside it is rejected), and
`setNetworkPolicy`. `NetworkPolicy` is `"deny-all"` (the secure default),
`"allow-all"`, or `{ allow: [...] }`; `networkAllows` / `normalizeHost` enforce
the allowlist and `makeCredentialBroker` brokers a named secret into the
`OutboundRequest`. Two backends ship: `inMemoryBackend` carries the unit suite
(an in-memory `/workspace`, a deterministic command allowlist, a firewall that
consults policy + broker), and `dockerBackend` gives real isolation via the
`docker` CLI (`docker run --network none` by default; exercised by a manual
docker smoke). `startEgressProxy` is the real host-side `node:http` forward proxy
that un-gates the docker backend's per-host `{allow}` egress: it enforces the
allowlist, brokers the credential named by the `SECRET_HEADER` (`x-iris-secret`)
into the outbound request, and keeps a live append-only `egress[]` audit log.
Secrets are never passed as `-e` / args / volume — they are brokered at the
proxy, so they never enter the container. Host-side; depends on `@irisrun/core`
only, zero external deps.

## Use it

Library-only (no CLI). Create a session from a backend (`inMemoryBackend` for
tests, `dockerBackend` for real isolation); for brokered egress, `startEgressProxy`
and route the container through it via `HTTP(S)_PROXY`.

See **[docs/Security: sandbox threat model](../../docs/reference/security-sandbox-threat-model.md)**
and **[docs/Tools](../../docs/tools.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
