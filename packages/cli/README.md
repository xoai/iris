# iris-runtime

**The `iris` command — author an agent, compile it to a portable image, run it
anywhere.** The install-free CLI for Iris: scaffold a config-plus-folder agent,
build it into an open, content-addressed image, and run / serve / chat / deploy
it — across hosts, models, and vendors — with the durable journal that makes a
session resume byte-identical wherever it lands.

## What it is

The unscoped npm package `iris-runtime` installs the `iris` binary. It wraps the
Iris runtime behind a zero-dependency argv dispatcher: each subcommand is a
unit-tested command function over `@irisrun/agent`, wired here to real fs / host
defaults (the SQLite store + the provider named by the image's model-id prefix).
Node ≥ 24, no build step.

## Use it

```sh
npm i -g iris-runtime        # or run ad hoc: npx iris-runtime <command>

iris init my-agent           # scaffold agent.yaml + instructions.md + a tools/now tool
cd my-agent
iris build --out ./image     # compile the content-addressed agent image
iris chat ./image --session s1 --fake   # talk to it — no API key needed
```

Drop `--fake` and set the provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)
for a real model.

**Command groups:**

- **Author & inspect** — `init`, `build`, `inspect`, `schema`, `providers`
- **Distribute** — `verify`, `push`, `pull` (local OCI layout; a real registry is manual)
- **Run** — `run`, `serve`, `chat`, `deploy` (`--target <name>` scaffolds for 9 platforms across edge / container / serverless; `--list-targets`)
- **Operate & assure** — `audit`, `eval`, `schedule`, `journal`

See the **[CLI reference](../../docs/reference/cli.md)** for every command's
flags, and the **[docs](../../docs/README.md)** for the guided path from `init`
to a deployed agent.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
