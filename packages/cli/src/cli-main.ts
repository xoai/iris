// The `iris` bin — a zero-dep argv dispatcher over the command functions
// (packages/demo/src/run.ts pattern). NOT unit-tested (the command fns are tested
// directly with injected deps); this wires real fs/host defaults. The `run` path
// uses the SQLite store + the Anthropic provider (needs a key) — the real path,
// exercised manually. Host-side.
import { makeLocalResolver } from "@iris/agent";
import type { Performer } from "@iris/core";
import { cmdInit, cmdBuild, cmdInspect, cmdVerify, cmdPush, cmdPull, cmdRun, cmdServe } from "./iris.ts";
import { echoStreamingPerformer } from "./echo.ts";

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
    default:
      console.error("usage: iris <init|build|inspect|verify|push|pull|run|serve>");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
