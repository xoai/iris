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
usage: iris run <layoutdir> --session <id> [--db <path>] [--tools <dir>] [--subagents <file>] [--env-file <file>] [--env KEY=VAL] [--secret-files]
```

- `--session <id>` — the durable session id (default `default`).
- `--db <path>` — SQLite store path (default `:memory:`).
- `--tools <dir>` — bundled-tools dir (default: the `tools/` sibling of the layout).
- `--subagents <file>` — subagent map (default `subagents.json` beside the layout).
- `--env-file <file>` / `--env KEY=VAL` — repeatable; supply the tool runtime env.
- `--secret-files` — materialize resolved secrets to `0600` temp files; tools get `<NAME>_FILE=<path>` instead of the value.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); not in the usage string but read in `runCommand`.

**`iris serve`** — boot the turnkey HTTP server (buffered REST + streaming SSE +
WebSocket). Defaults to a no-key echo model so it is demoable immediately.

```
usage: iris serve <layoutdir> [--port N] [--host H] [--db path] [--model auto|anthropic|openai|echo] [--web] [--policy <file.json>] [--subagents <file>] [--env-file <file>] [--env KEY=VAL] [--secret-files]
```

- `--port N` (default `8787`), `--host H` (default `127.0.0.1`).
- `--db <path>` — store path (default `./iris-serve.sqlite`; a server wants durability).
- `--model auto|anthropic|openai|echo` — backend (default `auto`: the pinned provider when its key is present, else `echo`).
- `--web` — also serve the web chat UI at `GET /`.
- `--policy <file.json>` — load a who-may-approve policy + approval inbox (see [Governance](../governance.md)).
- `--subagents`, `--env-file`, `--env`, `--secret-files` — as for `run`.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); read in `serveCommand`, not in the usage string.

**`iris chat`** — the interactive terminal REPL; a non-safe tool call pauses for inline
y/n approval.

```
usage: iris chat <layoutdir> --session <id> [--db <path>] [--tools <dir>] [--subagents <file>] [--policy <file.json>] [--as <id>] [--role <r>] [--env-file <file>] [--env KEY=VAL] [--secret-files] [--fake]
```

- `--session <id>` (default `default`), `--db <path>` (default `:memory:` — warns it won't persist).
- `--policy <file.json>` — who-may-approve policy; without it the local user is the approver.
- `--as <id>` — principal id (default `local`); `--role <r>` — repeatable role (default `operator`).
- `--fake` — force the deterministic fake model (replies echo your input).
- `--tools`, `--subagents`, `--env-file`, `--env`, `--secret-files` — as for `run`.
- `--base-url <url>` — endpoint override (or `IRIS_MODEL_BASE_URL`); read in `chatCommand`, not in the usage string.

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

**`iris deploy`** — scaffold a Cloudflare Worker + Durable Object project (runs the
capability-diff gate first). Scaffold-only by default. See [Deploy](../deploy.md).

```
usage: iris deploy <layoutdir> [--out dir] [--name n] [--deploy]
```

- `--out <dir>` — output project dir (default `./iris-edge`).
- `--name <n>` — wrangler worker name (default: the image's agent name, sanitized).
- `--deploy` — run `wrangler deploy`. Refuses unless `IRIS_DEPLOY=1` is set and `wrangler` is on `PATH`; omit it to scaffold only.

---

## Audit & ops

Inspect a recorded session, run evals, schedule recurring jobs, move journals, and list
providers. The compliance side of these is covered in
[Audit & evals](../audit-and-evals.md).

**`iris audit`** — print a compliance-grade, replay-verified audit of a session recorded
by a prior `run`/`serve`/`chat`.

```
usage: iris audit <session> --db <path> [--interactive] [--json]
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
usage: iris schedule <layoutdir> --interval <ticks> --max-runs <n> [--ticks <n>] [--db <path>] [--session <id>]
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
