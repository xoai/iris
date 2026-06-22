# CLI reference

Every `iris <cmd>`, with the flags taken from the command's own `usage:` string (or,
where a command has none, from the dispatcher). This is a lookup table, not a walkthrough
— for the guided path start at the [docs index](../README.md).

> Flags below are quoted from `packages/cli/src/cli-main.ts`. Where a command ships no
> `usage:` string, that is noted and the synopsis is minimal — those commands take only
> the flags shown.

## Two ways to invoke

Every page writes `iris <cmd>`. That resolves two ways:

```sh
npx iris-runtime <cmd>                                        # the published bin (or: npm i -g iris-runtime)
node --conditions=iris-src packages/cli/src/cli-main.ts <cmd> # from a clone, no install, no build step
```

Substitute whichever form you use; the arguments are identical. The npm package is
**`iris-runtime`**; the installed binary is **`iris`**.

The full top-level surface:

```
iris <init|build|inspect|schema|providers|verify|push|pull|run|serve|chat|deploy|audit|eval|schedule|journal>
```

---

## Author & build

Scaffold a project, compile it to an image, and inspect or verify the result.

| Command | Synopsis | Flags |
| --- | --- | --- |
| `iris init [dir]` | Scaffold a self-contained project: `agent.yaml` (or `agent.json`), `instructions.md`, and a bundled `now` tool. | `--json` (author `agent.json` instead of the YAML default); `dir` is the first non-flag positional, default `.` |
| `iris adapter init <store\|channel\|provider> <name> [dir]` | Scaffold a buildable **adapter** package wired to `@irisrun/sdk` + the matching conformance suite (one dependency). | `dir` default `.`; refuses a non-empty target (no-clobber); unknown kind is a loud usage error. See the [adapter SDK](../sdk.md). |
| `iris build` | Compile the Agentfile to an OCI image layout (auto-detects `agent.json` → `agent.yaml` → `agent.yml`). | `--file <path>` (explicit Agentfile; wins over auto-detect), `--out <dir>` (default `./image`), `--tools <dir>` (default `<agent dir>/tools`) |
| `iris inspect <layoutdir>` | Print the image inspection (model, tools, capabilities) as JSON. | none |
| `iris verify <layoutdir>` | Re-resolve the image's tool refs and verify the lock. | `--tools <dir>` (default `tools`) |
| `iris schema` | Print the published Agentfile JSON Schema (draft 2020-12). Pipe to a file for editor/CI validation. | none |

These five commands ship **no `usage:` string** — the flags above are read from the
dispatcher's `main()` switch, not a quoted usage line. `init`, `inspect`, and `schema`
take no flags beyond what is shown.

---

## Run & serve

Drive an image: one turn, a server, or an interactive REPL.

**`iris run`** — run one turn against an image with the real host wiring (SQLite store +
the provider selected from the image's model-id prefix).

```
usage: iris run <layoutdir> --session <id> [--db <path>] [--store <name|module>] [--provider <module>] [--tools <dir>] [--subagents <file>] [--mcp <file>] [--openapi <file>] [--sandbox] [--env-file <file>] [--env KEY=VAL] [--secret-files]
```

- `--session <id>` — the durable session id (default `default`).
- `--db <path>` — store path / URL (default `:memory:`); for a third-party store it's the connection string (e.g. a `postgres://…` DSN).
- `--store <name|module>` — the host store: a built-in (`sqlite` default · `fs` · `memory`) or **any module exporting `openStore({ url })`** — plug & play, no fork. Shipped peer-dep-only stores: `@irisrun/store-postgres` · `@irisrun/store-mysql` · `@irisrun/store-redis` · `@irisrun/store-mongo` (install the matching driver — `pg` / `mysql2` / `redis` / `mongodb` — and pass its connection string as `--db`). On `run` / `serve` / `chat` / `audit` / `schedule`. See [adding a store](../contributing/adding-a-store.md). (`iris journal` separately overloads `--store` as a db-path alias.)

  ```sh
  npm i pg @irisrun/store-postgres        # the driver is yours; Iris stays zero-dep
  iris serve ./image --store @irisrun/store-postgres --db postgres://user@host/agents
  # …or --store @irisrun/store-mysql --db mysql://…  / store-redis --db redis://…  / store-mongo --db mongodb://…
  ```
- `--provider <module>` — the model provider: by default the image's `<provider>/` model-id prefix selects a built-in (`anthropic` · `openai`); pass a module exporting `openModelProvider()` to forklessly load a third-party provider (the prefix is still stripped for the API but need not be a known built-in). On `run` / `serve` / `chat` (not `deploy`). See [adding a provider](../contributing/adding-a-provider.md).
- `--tools <dir>` — bundled-tools dir (default: the `tools/` sibling of the layout).
- `--subagents <file>` — subagent map (default `subagents.json` beside the layout).
- `--mcp <file>` — MCP-server map for the image's `mcp://` tools (default `mcp.json` beside the layout): a JSON array of `{ name, command, args? }` where `name` is the tool's **location handle** (the `mcp://` ref minus scheme, shown by `iris inspect`). The scoped tool env reaches each server. On `run` / `serve` / `chat`.
- `--openapi <file>` — OpenAPI tool map for the image's `http://` tools (default `openapi.json` beside the layout): a JSON array of `{ name, spec, baseUrl, authSecretEnv? }`. Each operation in the referenced OpenAPI 3.0 spec becomes an `http://<name>/<operationId>` tool; `authSecretEnv` names a secret injected on the `Authorization` header. On `run` / `serve` / `chat`.
- `--sandbox` — run the image's `subprocess://` tools inside the sandbox declared by its Agentfile `sandbox:` block (off by default — without it, tools run host-side; refuses an `inmemory` backend for real tools). Real in-docker execution requires Docker. On `run` / `serve` / `chat`.
- `--env-file <file>` / `--env KEY=VAL` — repeatable; supply the tool runtime env.
- `--secret-files` — materialize resolved secrets to `0600` temp files; tools get `<NAME>_FILE=<path>` instead of the value.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); not in the usage string but read in `runCommand`.

**`iris serve`** — boot the turnkey HTTP server (buffered REST + streaming SSE +
WebSocket). Defaults to a no-key echo model so it is demoable immediately.

```
usage: iris serve <layoutdir> [--port N] [--host H] [--db path] [--store <name|module>] [--model auto|anthropic|openai|echo] [--provider <module>] [--channel <module>] [--web] [--policy <file.json>] [--subagents <file>] [--mcp <file>] [--openapi <file>] [--sandbox] [--env-file <file>] [--env KEY=VAL] [--secret-files]
```

- `--port N` (default `8787`), `--host H` (default `127.0.0.1`).
- `--db <path>` — store path (default `./iris-serve.sqlite`; a server wants durability).
- `--model auto|anthropic|openai|echo` — backend (default `auto`: the pinned provider when its key is present, else `echo`).
- `--provider <module>` — forkless third-party provider (as for `run`); when set it overrides `--model auto`, but `--model echo` still wins.
- `--channel <module>` — the serving channel: `rest` (default — the built-in REST/SSE/WebSocket transport) or a module exporting `openChannel(opts)`. Complements the [bridge pattern](../reference/bridge-pattern.md) (a bridge is the any-language, no-package path); `--channel` is for an in-process channel. See [adding a channel](../contributing/adding-a-channel.md).
- `--web` — also serve the web chat UI at `GET /`.
- `--policy <file.json>` — load a who-may-approve policy + approval inbox (see [Governance](../governance.md)).
- `--subagents`, `--mcp`, `--openapi`, `--sandbox`, `--env-file`, `--env`, `--secret-files` — as for `run`.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); read in `serveCommand`, not in the usage string.

**`iris chat`** — the interactive terminal REPL; a non-safe tool call pauses for inline
y/n approval.

```
usage: iris chat <layoutdir> --session <id> [--db <path>] [--store <name|module>] [--provider <module>] [--tools <dir>] [--subagents <file>] [--mcp <file>] [--openapi <file>] [--sandbox] [--policy <file.json>] [--as <id>] [--role <r>] [--env-file <file>] [--env KEY=VAL] [--secret-files] [--fake]
```

- `--session <id>` (default `default`), `--db <path>` (default `:memory:` — warns it won't persist).
- `--policy <file.json>` — who-may-approve policy; without it the local user is the approver.
- `--as <id>` — principal id (default `local`); `--role <r>` — repeatable role (default `operator`).
- `--fake` — force the deterministic fake model (replies echo your input); wins over `--provider`.
- `--provider <module>`, `--tools`, `--subagents`, `--mcp`, `--openapi`, `--sandbox`, `--env-file`, `--env`, `--secret-files` — as for `run`.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); read in `chatCommand`, not in the usage string.

**`iris bridge`** — serve a **platform bridge** (Discord, Telegram, Teams, WhatsApp,
Twilio, Google Chat, …) in front of a running channel: it speaks the platform's webhook
in and the Iris REST channel wire out, so a chat platform reaches a durable session with
**no core change**. Pluggable by module specifier — the channel analog of `--store`.

```
usage: iris bridge <module> --base-url <iris-channel-url> [--port N] [--host H]
```

- `<module>` — a module exporting **`openBridge(opts)`** (an `@irisrun/bridge` `OpenBridge`); it builds the platform adapter from the environment. The six shipped reference adapters live at `examples/bridges/<platform>.ts` (copy & adapt — they're examples, not packages, per the [bridge pattern](../reference/bridge-pattern.md)).
- `--base-url <url>` — **required**: where `iris serve` is listening (e.g. `http://127.0.0.1:8787`).
- `--port N` (default `8788`), `--host H` (default `127.0.0.1`) — where the bridge itself listens for the platform's webhook.
- Platform config comes from the **environment** (per adapter): `DISCORD_PUBLIC_KEY` · `TELEGRAM_SECRET_TOKEN` · `TEAMS_SHARED_SECRET` · `WHATSAPP_APP_SECRET` · `TWILIO_AUTH_TOKEN`+`TWILIO_WEBHOOK_URL` · `GOOGLE_CHAT_TOKEN`.
- Not a deploy verb (the forkless-module deploy restriction does not apply).

```sh
iris serve ./image --port 8787 &     # 1) the durable Iris channel
DISCORD_PUBLIC_KEY=<app-public-key> \
  iris bridge ./examples/bridges/discord.ts --base-url http://127.0.0.1:8787   # 2) the bridge
# point your platform's webhook at the bridge's URL (default http://127.0.0.1:8788)
```

---

## Registry

Move an image between local OCI layouts. (A real external registry is a manual smoke;
these copy layout directories.)

| Command | Synopsis | Flags |
| --- | --- | --- |
| `iris push <layoutdir> <dest>` | Copy an image layout to `dest`. | none (two positionals) |
| `iris pull <src> <layoutdir>` | Copy an image layout from `src`. | none (two positionals) |

Both ship **no `usage:` string** — the positionals above are read from `cmdPush` /
`cmdPull`.

---

## Deploy

**`iris deploy`** — scaffold a deploy project for a chosen platform (runs the
capability-diff gate first). Scaffold-only by default. See [Deploy](../deploy.md).

```
usage: iris deploy <layoutdir> [--target <name>] [--out dir] [--name n] [--deploy] [--list-targets]
```

- `--target <name>` — the deploy target (default `cloudflare`). Nine targets across
  three families: **edge** (`cloudflare`); **container** (`render`, `gcp-cloud-run`,
  `azure-container-apps`, `digitalocean-app`, `docker`); **serverless** (`aws-lambda`,
  `gcp-cloud-functions`, `azure-functions`).
- `--list-targets` — print the available targets (name · family · description) and exit.
- `--out <dir>` — output project dir (default `./iris-edge`).
- `--name <n>` — service/worker name (default: the image's agent name, sanitized).
- `--deploy` — run the real deploy (**Cloudflare/`wrangler` only**). Refuses unless `IRIS_DEPLOY=1` is set and `wrangler` is on `PATH`; for other targets it is refused loudly (scaffold then run the printed deploy command manually).
- Forkless `--provider` / `--channel` modules are **not** supported at deploy time (the generated worker/handler bakes in a built-in provider) — `iris deploy` refuses them loudly. Use them with `run` / `serve` / `chat`.

---

## Audit & ops

Inspect a recorded session, run evals, schedule recurring jobs, move journals, and list
providers. The compliance side of these is covered in
[Audit & evals](../audit-and-evals.md).

**`iris audit`** — print a compliance-grade, replay-verified audit of a session recorded
by a prior `run`/`serve`/`chat`.

```
usage: iris audit <session> --db <path> [--store <name|module>] [--interactive] [--json]
```

- `--db <path>` — the store from a previous session (default `:memory:`, which warns it has no prior session).
- `--interactive` — force interactive-journal handling (overrides auto-detection).
- `--json` — emit `{ audit, verify }` as JSON instead of text.

**`iris eval`** — run a reproducible eval suite (a module exporting `cases` + `scorer`).

```
usage: iris eval <suite.mjs> [--reproduce <N>] [--json]
```

- `--reproduce <N>` — prove each case byte-identical over `N` runs.
- `--json` — emit the reports/results as JSON.

**`iris schedule`** — run a recurring, durably-replayable heartbeat job pinned to an
image; prints one JSON line per committed cycle.

```
usage: iris schedule <layoutdir> --interval <ticks> --max-runs <n> [--ticks <n>] [--db <path>] [--store <name|module>] [--session <id>]
```

- `--interval <ticks>` — ticks between cycles (default `10`).
- `--max-runs <n>` — how many cycles to run (default `3`).
- `--ticks <n>` — pump steps this invocation (default = `max-runs`; warns if too few to finish).
- `--db <path>` (default `:memory:`, warns it won't persist), `--session <id>` (default `schedule`).

**`iris journal <export|verify|import>`** — the verifiable portable journal. A subcommand
group, since `iris verify` already means image verification. Each subcommand has its own
usage string:

```
usage: iris journal export <session> --store <db> --out <file>
usage: iris journal verify <file> [--replay] [--image <layoutdir>] [--json]
usage: iris journal import --in <file> --store <db>
```

- `export` — `--store <db>` (alias `--db`), `--out <file>`.
- `verify` — file-only by default; `--replay` re-runs, `--image <layoutdir>` pins the expected def digest, `--json` emits the result. Exits non-zero on failure.
- `import` — `--in <file>`, `--store <db>` (alias `--db`).

**`iris providers`** — read-only. List the two model protocols and how to point a portable
image at any compatible endpoint. See [Models & providers](../providers.md).

| Command | Synopsis | Flags |
| --- | --- | --- |
| `iris providers` | List the protocols (`anthropic/` → Anthropic Messages, `openai/` → OpenAI Chat Completions) and the `--base-url` override. | `--matrix` (print the conformance-verified compatibility matrix) |

`providers` ships **no `usage:` string** — `--matrix` is read from `providersCommand`.

---

Back to the **[docs index](../README.md)** · **[Deploy](../deploy.md)** ·
**[Audit & evals](../audit-and-evals.md)** · **[Governance](../governance.md)** ·
**[Models & providers](../providers.md)** · the **[project README](../../README.md)**.
