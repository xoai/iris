# The sandbox — the untrusted-code security floor

When a tool runs code you don't fully trust, the danger isn't the code running —
it's what it can *reach* (the network) and what it can *read* (your secrets).
`@irisrun/sandbox` is the floor that bounds both: untrusted code acts through a
`SandboxSession` rooted at `/workspace` with a **deny-all** network default, and
when it does reach out, secrets are **brokered at the egress boundary** — injected
into the outbound request as it leaves, so only a marker *name* ever crosses into
the box.

> **Status — read this first.** The sandbox is the part of Iris that is **not yet
> wired into the runtime**. `@irisrun/sandbox` ships the boundary, two backends,
> and an adversarially-reviewed threat model — but nothing in the agent/tool loop
> runs a tool inside a sandbox automatically today. This page documents the
> **library** as it honestly exists, not a feature you switch on from an
> Agentfile. See [Honest status](#honest-status) for exactly what is and isn't
> connected.

## What it is

`@irisrun/sandbox` is host-side, zero-dependency, and **library-only — no CLI**.
Two pieces (`packages/sandbox/src/backend.ts`):

- a **backend** — a `SandboxBackend` whose `create(opts?)` makes sessions. The
  exported `inMemoryBackend()` and `dockerBackend()` are **factories** that return
  one, so you call the factory, then `.create(...)`, and
- a **session** — the boundary an untrusted tool acts through.

A `SandboxSession` exposes exactly four operations:

| Method | What it does |
|---|---|
| `session.run(cmd)` | run a command, block until it exits → `{ stdout, stderr, exit }` |
| `session.readFile(path)` | read a file — rooted at `/workspace`; a path outside it is **rejected** |
| `session.writeFile(path, bytes)` | write a file — same rooting rule |
| `session.setNetworkPolicy(policy)` | tighten or loosen egress at runtime |

`setNetworkPolicy` is a **method on the session**, not a top-level import. A
`NetworkPolicy` is one of three shapes — `"deny-all"` (the secure default),
`"allow-all"`, or a host allowlist `{ allow: ["api.github.com"] }`.

## Use it — the in-memory backend

`inMemoryBackend` is a deterministic test double: an in-memory `/workspace`, a
tiny fixed command set (`echo`, `write`, `read`, `fetch`), and the **same**
firewall + credential broker the real backend uses. It's how the firewall and
broker get exercised in unit tests without Docker — reach for it to understand the
shape:

```ts
import { inMemoryBackend, makeCredentialBroker } from "@irisrun/sandbox";

const broker = makeCredentialBroker({ GITHUB_TOKEN: process.env.GITHUB_TOKEN! });
const session = await inMemoryBackend().create({ // inMemoryBackend() is a factory
  network: { allow: ["api.github.com"] }, // egress allowlist (deny-all is the default)
  broker,
});

// Paths are rooted at /workspace — an absolute path under it, not a relative one.
await session.writeFile("/workspace/notes.md", new TextEncoder().encode("# scratch\n"));

// `fetch <host> secret:<name>` goes through the firewall: the host is allow-listed
// and the broker injects GITHUB_TOKEN at the boundary — the value never enters here.
const res = await session.run("fetch api.github.com secret:GITHUB_TOKEN");
// res.exit === 0
```

`create` takes `{ network?, env?, broker? }`. `env` is **sandbox-visible** and must
never hold a secret; secrets go to the broker, which keeps them outside the box.

## Credentials never enter the box

The point of the broker is that a sandboxed tool can make an *authenticated*
request **without ever holding the credential**:

1. The tool names a secret with the `x-iris-secret` header (`SECRET_HEADER`) —
   e.g. `x-iris-secret: GITHUB_TOKEN`.
2. The egress boundary checks the host against the allowlist, **strips the marker**,
   and the broker injects the real value as `authorization: Bearer <value>` into the
   **outbound** request only.
3. The secret appears in no sandbox-visible surface — not the env, stdout, files,
   or `/workspace`. Only the marker name was ever inside.

`makeCredentialBroker(secrets)` holds the values host-side and exposes only
`has(name)` — so the boundary can fail loudly on an unknown secret *before*
anything egresses — and `authorize(request, name)`, the one path a secret leaves
by. There is no getter that hands a raw secret to sandbox code.

## Real isolation — the docker backend + egress proxy

`dockerBackend` gives real isolation via the `docker` CLI (`docker run
--network none` by default, so the deny-all floor is the container's actual
network). For a tool that needs *allowlisted* egress, the `{allow}` policy is
un-gated by a host-side sidecar — `startEgressProxy`:

```ts
import { createDockerSession, startEgressProxy, makeCredentialBroker } from "@irisrun/sandbox";

const broker = makeCredentialBroker({ GITHUB_TOKEN: process.env.GITHUB_TOKEN! });
const proxy = await startEgressProxy({ policy: { allow: ["api.github.com"] }, broker });

// A per-host {allow} policy on docker REQUIRES the proxy handle — pass it as
// `egress`, and the container is routed through it (HTTP(S)_PROXY = proxy.url).
const session = await createDockerSession({
  network: { allow: ["api.github.com"] },
  broker,
  egress: proxy,
});
// ... run the tool ...
await proxy.close();
```

`await startEgressProxy({ policy, broker?, host? })` resolves to a handle with
`url` (for `HTTP(S)_PROXY` — it never embeds credentials), a live `egress` audit
view of what actually left, `setPolicy(...)` to retighten at runtime, and
`close()`. Passing that handle as `egress` is what un-gates a `{allow}` policy on
the docker backend — without it, `createDockerSession` **refuses** a per-host
allowlist loudly rather than silently granting open egress. The proxy enforces the
allowlist and brokers credentials at the boundary, so the secret is never passed to
the container as `-e`, an argument, or a volume.

> Two limits the [threat model](../reference/security-sandbox-threat-model.md)
> spells out: brokering is **plaintext-HTTP only** (an HTTPS `CONNECT` tunnel is
> end-to-end TLS, so the proxy gates the host but cannot inject a credential
> without MITM — that is refused, not faked), and docker-level enforcement is
> **cooperative by default** (`HTTP(S)_PROXY` routes a well-behaved client; *hard*
> enforcement means running the container on an internal network so the proxy is
> the only way out).

## Honest status

Two things a reader could reasonably assume are wired — and aren't:

- **The sandbox is not consumed by the tool loop.** Every caller of
  `@irisrun/sandbox` outside the package is a test or a manual smoke script — no
  `@irisrun/host`, `@irisrun/tools`, or `@irisrun/agent` constructs a session to
  run a tool, and the package boundary test asserts the pure core never imports it.
  So today a `subprocess://` tool runs **host-side** with least-privilege env (see
  [secrets & environment](./secrets.md)); it does **not** run inside a
  `@irisrun/sandbox` session.
- **The Agentfile `sandbox:` block is declarative-only.** An Agentfile carries a
  `sandbox: { backend, network, workspace? }` block, and it is parsed and
  validated — but only `sandbox.workspace` is consumed (hashed into the image as a
  content path). `backend` and `network` are validated and otherwise inert: no
  field constructs a session yet. Treat the block as a forward-declared intent, not
  an active control.

Stated plainly: the *floor* (deny-all, brokering, backends, threat model) is real
and tested; *wiring it into the runtime* so a tool automatically runs behind it is
the next initiative, not a flag you can flip today.

## Not yet / on the roadmap

- **Runtime wiring** — the harness running a tool inside a session.
- **More backends** — two ship today (`inMemoryBackend` for tests, `dockerBackend`
  for real isolation); a hosted/VM backend and a no-Docker local backend are not
  here.
- **A convenience layer** — seeding `/workspace` from a project directory and
  per-session lifecycle hooks aren't provided; you wire `writeFile`/`run` yourself.
- **Brokering over TLS** — deferred (today an HTTPS tunnel is gated but un-brokered,
  correctly refused rather than faked).

---

Built on the **[sandbox-egress threat model](../reference/security-sandbox-threat-model.md)** ·
the host-side credential layer in **[secrets & environment](./secrets.md)** ·
the tool boundary in **[Tools](../tools.md)**.
