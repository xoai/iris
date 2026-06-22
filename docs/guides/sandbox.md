# The sandbox — the untrusted-code security floor

When a tool runs code you don't fully trust, the danger isn't the code running —
it's what it can *reach* (the network) and what it can *read* (your secrets).
`@irisrun/sandbox` is the floor that bounds both: untrusted code acts through a
`SandboxSession` rooted at `/workspace` with a **deny-all** network default, and
when it does reach out, secrets are **brokered at the egress boundary** — injected
into the outbound request as it leaves, so only a marker *name* ever crosses into
the box.

> **Status — read this first.** A subprocess tool can run inside the sandbox
> **opt-in** via `iris run|serve|chat --sandbox` (off by default — without it, a
> tool runs host-side exactly as before). The *wiring* — the session API, the
> transport seam, and the activation refusals — is CI-verified; **real in-container
> execution is smoke-gated** (it needs Docker, so the unit suite doesn't prove it).
> See [Honest status](#honest-status) for exactly what is verified vs. gated.

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

`iris … --sandbox` runs the image's subprocess tools inside the sandbox, using the
backend + network from the Agentfile `sandbox:` block. With `--sandbox` absent (the
default) a `subprocess://` tool runs **host-side** with least-privilege env (see
[secrets & environment](./secrets.md)), byte-for-byte as before. What's *verified*
vs. *gated*, stated plainly:

- **Verified in CI:** the wiring — the `run(cmd, { stdin })` API, the zero-value-off
  `SandboxExecutor` seam on the subprocess transport (off ⇒ identical to the
  bare-spawn path), and `--sandbox`'s loud refusals (an `inmemory` backend can't
  execute real tools; a non-node or multi-file tool is rejected).
- **Smoke-gated (NOT in CI):** real in-container execution. Running a tool in Docker
  needs a node image + a host→container command/path rewrite + staging — the
  `--sandbox` docker adapter does this, but it is exercised only by
  `tests/smoke/docker-smoke.ts` (run on a machine with Docker), never the unit
  suite. Treat real isolation as *implemented and reference-tested*, not CI-proven.
- **Scope today:** single-file **node** exec tools only; `mcp://`/`grpc://`,
  multi-file/native tools, and per-host allowlist egress under `--sandbox` are not
  wired.

`@irisrun/cli` depends on `@irisrun/sandbox` to do this; the pure core imports
neither `@irisrun/sandbox` nor `@irisrun/tools` (the boundary test pins that).

## Not yet / on the roadmap

- **Broader runtime wiring** — `--sandbox` runs single-file node `subprocess://`
  tools in a docker sandbox (real execution smoke-gated); `mcp://`/`grpc://`,
  multi-file/native tools, allowlist egress, and an always-on mode remain.
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
