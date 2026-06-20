# Secrets & environment

A subprocess tool often needs a secret — a `GITHUB_TOKEN`, an API key. Two rules keep
that safe.

## Declare names, not values

An Agentfile lists the env its tools need; the image stores only NAMES. A secret VALUE
never enters the manifest, the image, or the journal.

```yaml
# agent.yaml
secrets:            # NAMES of required secrets — values supplied at run time
  - GITHUB_TOKEN
environment:        # non-secret literal defaults (baked into the recipe)
  LOG_LEVEL: info
```

## Supply values at run time

docker-compose style — values come from a file and/or flags, never committed:

```sh
iris run ./image --session s1 --env-file .env --env LOG_LEVEL=debug
```

`--env-file` (repeatable) reads `KEY=VALUE` lines; `--env KEY=VALUE` (repeatable)
overrides. Precedence for a declared secret: `--env` > `--env-file` > the host
environment. A declared secret with no value from any source **refuses to run** — loudly,
by name, never a half-started session. `iris inspect` shows exactly what an image requires.

> ⚠ Passing a secret inline with `--env GITHUB_TOKEN=…` puts the **value on the command
> line** (visible in `ps`, shell history, `/proc/<pid>/cmdline`). Iris warns when you do
> this — use `--env-file` for secrets, and `--env` only for non-sensitive overrides.

## Two delivery tiers

By default a secret is delivered as an **environment variable** (the tool reads
`process.env.GITHUB_TOKEN`). For the strongest isolation, add `--secret-files`: each
secret is written to a `0600` temp file and the tool receives
`GITHUB_TOKEN_FILE=/run/iris-secrets/GITHUB_TOKEN` instead — the **value never enters the
tool's environment** at all (the same `*_FILE` convention apps use for `/run/secrets/*`).
Your tool reads the path:

```js
// inside a tool, prefer the file when present:
const token = process.env.GITHUB_TOKEN_FILE
  ? readFileSync(process.env.GITHUB_TOKEN_FILE, "utf8").trim()
  : process.env.GITHUB_TOKEN;
```

## Least privilege

When an Agentfile declares `secrets` / `environment`, its subprocess tools receive ONLY
that declared env plus a fixed, non-secret base (`PATH`, `HOME`, proxy/TLS vars) — never
the operator's whole shell. An undeclared `--env` / `--env-file` key is refused, so a
stray secret can't leak in through a copied env file.

This is a different layer from the [sandbox credential broker](../reference/security-sandbox-threat-model.md):
the broker injects a secret at the *network egress* boundary so a sandboxed tool never
sees it; subprocess-tool env is *host-side*, for a tool that legitimately needs the value
in its environment to run. Both keep the value out of the image and the journal. An
Agentfile that declares neither keeps today's behavior — the tool inherits the host
environment.

---

Back to **[Tools](../tools.md)** · the
**[sandbox threat model](../reference/security-sandbox-threat-model.md)**.
