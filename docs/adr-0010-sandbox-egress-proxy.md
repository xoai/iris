# ADR-0010 — Sandbox egress proxy (real per-host egress + credential brokering)

- **Status:** Accepted — 2026-06-20
- **Supersedes:** the "deferred — needs a sidecar egress proxy" notes in
  `packages/sandbox/src/{backend,docker}.ts` (this is the `ADR-0010` those
  comments reference; before this it existed only as that provenance).

## Context

`@iris/sandbox` is the security floor for untrusted tool code: a `SandboxSession`
rooted at `/workspace` with a **deny-all** network default and **credential
brokering** so a secret is injected only at the egress boundary and never
materializes inside the sandbox.

Two backends implement the boundary:

- **inmemory** (unit suite) — implements the full firewall: per-host `{allow}`
  allowlist, a `CredentialBroker` that injects a named secret into the outbound
  request at egress, and an `egress[]` audit log.
- **docker** (real isolation, manual smoke) — implemented `deny-all`
  (`--network=none`) and `allow-all` (`--network=bridge`) only. A per-host
  `{allow:[...]}` policy was **refused loudly**, and there was **no credential
  brokering at real egress at all**. Both were explicitly deferred "pending a
  sidecar egress proxy."

So the README's headline security properties — "networking denied by default,
credentials brokered so secrets never enter the sandbox" — were only half-true
for the backend that actually isolates. The refusal was the *honest* placeholder
(better a loud refusal than silently mapping a restricted allowlist to open
`bridge` egress), but it left a real capability gap.

## Decision

Ship the **sidecar egress proxy** the comments referenced, and **conditionally
un-gate** the docker backend.

1. **`EgressProxy`** (`packages/sandbox/src/egress-proxy.ts`) — a host-side
   `node:http` **forward proxy** that reproduces the inmemory firewall's three
   guarantees over real sockets:
   - **allowlist** — `networkAllows(policy, host)` (reused unchanged, exact-match)
     gates every request; a non-allowlisted host is refused `403`, never forwarded.
   - **credential brokering** — a request naming a secret via the `x-iris-secret`
     header has that marker stripped and the named credential injected
     (`CredentialBroker.authorize`, reused unchanged) into the **upstream**
     request only. An unknown secret is a `403` refusal **before** egress.
   - **audit** — a live `egress[]` log of every `OutboundRequest` that left.
2. **Conditional docker un-gate** — `createDockerSession` accepts an optional
   `egress: EgressProxyHandle`. A `{allow}` policy is accepted **iff** a proxy is
   wired (`hasProxy`, fixed and immutable at create, threaded into both the
   create-time and `setNetworkPolicy`-time policy checks). The container runs on
   `--network=bridge` with `HTTP(S)_PROXY` + `--add-host=host.docker.internal:
   host-gateway` pointing at the proxy. **Without a proxy, `{allow}` is still
   refused loudly** — the secure floor is unchanged.

## Honest boundaries (what this does NOT claim)

- **HTTPS `CONNECT` is allowlist-only.** A CONNECT tunnel is end-to-end TLS, so
  the proxy can enforce the host allowlist (it sees the CONNECT authority) but
  **cannot inject a credential** without TLS termination (MITM). Brokering is
  therefore plaintext-HTTP only; brokering-over-TLS is **documented as deferred,
  not faked** — silently appearing to broker over TLS would be a security lie.
- **Docker-level enforcement is cooperative by default.** `--network=bridge` +
  `HTTP_PROXY` env routes *well-behaved* clients through the proxy, but a tool
  that ignores the proxy env can still reach the bridge. **Hard** enforcement
  (the proxy as the *sole* egress) is a deployment concern — run the container on
  an internal docker network / behind a host firewall so the proxy is the only
  route out. The secure **floor** (no-proxy `{allow}` refused; `deny-all` = no
  network at all) does not depend on cooperation.
- **The secret in `egress[]` is host-side audit, not a leak.** The audit record
  carries the brokered `authorization` exactly as the inmemory backend's
  `egress[]` does (asserted by `tests/sandbox-inmemory.test.ts`). It lives
  outside the sandbox; the sandbox surfaces (env, `/workspace`, stdout) never
  carry the secret, and the proxy never logs it.

## Consequences

- The docker backend reaches parity with the inmemory firewall for real network
  egress, making the secure-by-default claim true for the backend that isolates.
- Additive and opt-in (zero-value-off): a session with no proxy and a
  deny-all/allow-all policy behaves byte-identically to before — no existing test
  re-baselined. The unit suite grew 535 → 546 (9 proxy + 2 docker with-proxy).
- No runtime dependency added (`node:http`/`node:net` only; `@iris/core` and the
  kernel untouched).
- **Out of scope (pre-existing gap):** wiring the docker sandbox / sandboxed tool
  execution into the runtime (host/tools/agent/cli). The sandbox package is the
  security floor; *consuming* it from the runtime is a separate initiative.
