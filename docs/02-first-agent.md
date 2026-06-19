# 02 — Your first agent

Goal: scaffold an agent, compile it, and have a real conversation with it — first
with **no API key**, then with a real model. Then prove the conversation survives a
process restart.

You need **Node.js ≥ 24**. Nothing else — Iris has zero runtime dependencies.

## 1. Scaffold

```sh
iris init ./my-agent
```

This writes a **self-contained** project (not an empty folder):

- `agent.json` — the Agentfile: the agent's name, `model`, instructions, and tools.
- `instructions.md` — the system prompt.
- `tools/now.mjs` + `tools/now.tool.json` — a bundled `now` tool the agent can call
  immediately, with no external server to stand up. (More on tools in
  [03 — Tools](./03-tools.md).)

## 2. Build the image

```sh
iris build --file ./my-agent/agent.json --out ./image
# → {"imageDigest":"sha256:…"}
```

`iris build` compiles the folder into a content-addressed image. Look inside it or
check its integrity any time:

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

(To use OpenAI instead, see [06 — Models & providers](./06-providers.md).)

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

**Next → [03 — Tools](./03-tools.md)**
