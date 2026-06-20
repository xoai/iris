# Your first agent

Goal: stand up a **durable session you own** — an agent whose whole conversation
lives in a journal, not in process memory, so it survives a restart and resumes
byte-identically. You'll scaffold an agent, compile it, and talk to it — first
with **no API key**, then with a real model — then kill the process and watch the
same session pick up exactly where it stopped.

You need **Node.js ≥ 24**. Nothing else — Iris has zero runtime dependencies.

> Every `iris <cmd>` below is `npx iris-runtime <cmd>` (or `npm i -g iris-runtime`) — or,
> from a clone, `node --conditions=iris-src packages/cli/src/cli-main.ts <cmd>`. See
> [running the commands](./README.md#running-the-commands-first).

## 1. Scaffold

```sh
iris init ./my-agent
```

This writes a **self-contained** project (not an empty folder):

- `agent.yaml` — the Agentfile: the agent's name, `model`, instructions, and tools.
  (YAML is the default — it carries comments; prefer JSON? `iris init ./my-agent --json`.)
- `instructions.md` — the system prompt.
- `tools/now.mjs` + `tools/now.tool.json` — a bundled `now` tool the agent can call
  immediately, with no external server to stand up. (More on tools in
  [Tools](./tools.md).)

## 2. Build the image

```sh
iris build --file ./my-agent/agent.yaml --out ./image
# → {"imageDigest":"sha256:…"}
```

`iris build` compiles the folder into a content-addressed image. (Run it from inside
the project and you can drop `--file` — `iris build --out ./image` auto-detects
`agent.json`/`agent.yaml`/`agent.yml`.) Look inside it or check its integrity any time:

```sh
iris inspect ./image
iris verify  ./image
```

## 3. Talk to it — no key required

`iris chat` is an interactive REPL. Pass `--fake` to use a deterministic echo model
(the same one the test suite uses), so you can try it with no API key:

```sh
printf 'hello\nwhat can you do?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:hello              ← printed token-by-token as it streams
# agent> echo:what can you do?
```

Replies **stream live**, token by token. `/exit`, `/quit`, or Ctrl-D leaves — the
session stays put on disk.

## 4. Talk to it — real model

Set the key for your agent's provider (the scaffold pins an `anthropic/…` model, so
`ANTHROPIC_API_KEY`) and drop `--fake`:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
iris chat ./image --session s2 --db /tmp/s2.sqlite
```

(To use OpenAI instead, see [Models & providers](./providers.md).)

## 5. The payoff — resume across a restart

The conversation **is** the session journal, so a brand-new process picks it up
exactly where it stopped — no re-streaming of earlier turns:

```sh
printf 'still there?\n/exit\n' \
  | iris chat ./image --session s1 --db /tmp/s1.sqlite --fake
# agent> echo:still there?      ← continues the SAME session; earlier turns are NOT replayed to you
```

Use a file path for `--db` to make a session durable; `--db :memory:` is for
throwaway runs.

## 6. Validate the Agentfile (editor autocomplete)

`iris build` validates the Agentfile, but you can also catch mistakes *while
editing* with the published JSON Schema. Emit it once into your project:

```sh
iris schema > agentfile.schema.json
```

Then reference it from your Agentfile — editors that understand `$schema` (VS Code,
most JSON/YAML extensions) will autocomplete fields and red-underline a bad
`tool_locality`, a missing `sandbox`, or a tool ref with the wrong scheme. In JSON,
add a `$schema` key; in YAML, add a `# yaml-language-server` comment at the top:

```json
{
  "$schema": "./agentfile.schema.json",
  "apiVersion": "iris/v1",
  "kind": "Agent",
  "name": "my-agent"
}
```

```yaml
# yaml-language-server: $schema=./agentfile.schema.json
apiVersion: iris/v1
kind: Agent
name: my-agent
```

The `$schema` key is editor/CI metadata only — Iris ignores it, so it never
changes the image digest. The same schema validates Agentfiles offline in CI
(it is a standard draft 2020-12 document) with no Iris install.

**Next → [Tools](./tools.md)**
