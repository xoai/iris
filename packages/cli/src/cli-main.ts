// The `iris` bin — a zero-dep argv dispatcher over the command functions
// (packages/demo/src/run.ts pattern). NOT unit-tested (the command fns are tested
// directly with injected deps); this wires real fs/host defaults. The `run` path
// uses the SQLite store + the Anthropic provider (needs a key) — the real path,
// exercised manually. Host-side.
import { createInterface } from "node:readline";
import { makeLocalResolver, readOciLayout, governingDigest } from "@iris/agent";
import { defaultBundle } from "@iris/core";
import type { Performer } from "@iris/core";
import { makeToolPerformer, makeToolRegistry, makeToolInvoker } from "@iris/tools";
import type { ToolContract } from "@iris/tools";
import { cmdInit, cmdBuild, cmdInspect, cmdVerify, cmdPush, cmdPull, cmdRun, cmdServe } from "./iris.ts";
import { echoStreamingPerformer } from "./echo.ts";
import { runChat, wrapModelForImage, makeChatFakeModel } from "./chat.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function runCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) throw new Error("usage: iris run <layoutdir> --session <id> [--db <path>]");
  const session = flag(argv, "--session") ?? "default";
  const db = flag(argv, "--db") ?? ":memory:";
  // Real path (manual): SQLite store + Anthropic provider (needs ANTHROPIC_API_KEY).
  const sqlite = await import("@iris/store-sqlite");
  const provider = await import("@iris/provider-anthropic");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);
  const outcome = await cmdRun(layout, {
    sessionId: session,
    store,
    scheduler,
    clock: { now: () => 0 },
    modelPerformer: provider.anthropicModelPerformer({}),
  });
  console.log(JSON.stringify({ status: outcome.status }));
}

// `iris serve <layoutdir> [--port N] [--host H] [--db path] [--model ...]` — the
// turnkey HTTP server: buffered REST + streaming SSE + a hand-rolled WebSocket.
// Defaults to a no-key echo streaming model so it is demoable immediately.
async function serveCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout)
    throw new Error(
      "usage: iris serve <layoutdir> [--port N] [--host H] [--db path] [--model auto|anthropic|echo]",
    );
  const port = Number(flag(argv, "--port") ?? 8787);
  const host = flag(argv, "--host") ?? "127.0.0.1";
  const db = flag(argv, "--db") ?? "./iris-serve.sqlite"; // a server wants durability (cf. run's :memory:)
  const modelOpt = flag(argv, "--model") ?? "auto";

  const sqlite = await import("@iris/store-sqlite");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);

  const hasKey =
    typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY !== "";
  const resolved = modelOpt === "auto" ? (hasKey ? "anthropic" : "echo") : modelOpt;

  let makeModelPerformer: (model: string, onDelta?: (t: string) => void) => Performer;
  if (resolved === "anthropic") {
    const provider = await import("@iris/provider-anthropic");
    makeModelPerformer = (model, onDelta): Performer =>
      provider.anthropicStreamingModelPerformer({ model, onDelta });
  } else {
    makeModelPerformer = (_model, onDelta): Performer => echoStreamingPerformer(onDelta);
  }

  const serve = await cmdServe(layout, {
    store,
    scheduler,
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer,
    port,
    host,
  });
  console.log(`iris serve: listening on ${serve.url} (model=${resolved})`);
  console.log("  POST /v1/session            — start (buffered; add Accept: text/event-stream for SSE)");
  console.log("  POST /v1/session/<id>/message — continue");
  console.log("  ws://<host>/v1/ws            — WebSocket (held connection)");

  const shutdown = (): void => {
    serve.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// `iris chat <layoutdir> --session <id> [--db <path>] [--fake]` — the interactive
// terminal chat client. Mirrors runCommand's host wiring (SQLite store + the real
// performers), then drives the testable runChat REPL over stdin/stdout. Not
// unit-tested (its testable pieces live in chat.ts) — this is the real-IO entry.
async function chatCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) {
    throw new Error("usage: iris chat <layoutdir> --session <id> [--db <path>] [--fake]");
  }
  const session = flag(argv, "--session") ?? "default";
  const db = flag(argv, "--db") ?? ":memory:";
  const forceFake = argv.includes("--fake");

  const sqlite = await import("@iris/store-sqlite");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);

  if (db === ":memory:") {
    console.warn(
      "iris chat: --db :memory: — this conversation will NOT persist after exit; pass --db <path> for a durable, resumable session",
    );
  }

  const image = await readOciLayout(layout);
  // Surface a held-pin-vs-layout mismatch — never silently override (migration is
  // the only sanctioned way to change a live pin); run under the HELD pin.
  const held = await governingDigest(store, session);
  if (held !== null && held !== image.lock.imageDigest) {
    console.warn(
      `iris chat: session '${session}' holds pin ${held} ≠ layout ${image.lock.imageDigest}; running under the HELD pin (use a definition migration to change it)`,
    );
  }
  const defDigest = held ?? image.lock.imageDigest;

  // Assemble performers (same shape as cmdRun): default bundle tactics, a
  // lock-derived tool performer, and a model performer (wrapped Anthropic, or the
  // deterministic fake when no key / --fake).
  const bundle = defaultBundle();
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(makeToolRegistry(contracts), makeToolInvoker({}));

  const hasKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY !== "";
  const useFake = forceFake || !hasKey;
  let modelPerformer: Performer;
  if (useFake) {
    console.warn(
      forceFake
        ? "iris chat: --fake — using the deterministic (fake model); replies echo your input"
        : "iris chat: no ANTHROPIC_API_KEY — using the deterministic (fake model); replies echo your input",
    );
    modelPerformer = makeChatFakeModel();
  } else {
    const provider = await import("@iris/provider-anthropic");
    modelPerformer = wrapModelForImage(provider.anthropicModelPerformer({}), image);
  }

  const rl = createInterface({ input: process.stdin });
  const isInteractive = process.stdin.isTTY === true;
  const banner =
    `iris chat — session '${session}' (db ${db})${useFake ? " (fake model)" : ` (${image.agentfile.model})`}\n` +
    "Type a message and press enter; /exit, /quit, or Ctrl-D to leave (the session stays durable).\n";

  // SIGINT lives HERE (the real-IO entry), not in runChat — so runChat stays a
  // testable unit free of process-global side effects.
  const onSigint = (): void => {
    process.stdout.write("\n");
    rl.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  try {
    await runChat({
      store,
      scheduler,
      clock: { now: () => 0 },
      defDigest,
      modelPerformer,
      tacticPerformer: bundle.tacticPerformer,
      toolPerformer,
      sessionId: session,
      input: rl,
      output: process.stdout,
      isInteractive,
      banner,
    });
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    store.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case "init":
      await cmdInit(argv[1] ?? ".");
      console.log("iris: scaffolded agent.json + instructions.md");
      break;
    case "build": {
      const image = await cmdBuild({
        file: flag(argv, "--file") ?? "agent.json",
        out: flag(argv, "--out") ?? "./image",
        resolver: makeLocalResolver({}), // real registry resolution is manual
      });
      console.log(JSON.stringify({ imageDigest: image.lock.imageDigest }));
      break;
    }
    case "inspect":
      console.log(JSON.stringify(await cmdInspect(argv[1]), null, 2));
      break;
    case "verify":
      await cmdVerify(argv[1], { resolver: makeLocalResolver({}) });
      console.log("iris: verify ok");
      break;
    case "push":
      await cmdPush(argv[1], argv[2]);
      console.log("iris: pushed (local OCI layout)");
      break;
    case "pull":
      await cmdPull(argv[1], argv[2]);
      console.log("iris: pulled (local OCI layout)");
      break;
    case "run":
      await runCommand(argv);
      break;
    case "serve":
      await serveCommand(argv);
      break;
    case "chat":
      await chatCommand(argv);
      break;
    default:
      console.error("usage: iris <init|build|inspect|verify|push|pull|run|serve|chat>");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
