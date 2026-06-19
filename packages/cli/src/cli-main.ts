// The `iris` bin — a zero-dep argv dispatcher over the command functions
// (packages/demo/src/run.ts pattern). NOT unit-tested (the command fns are tested
// directly with injected deps); this wires real fs/host defaults. The `run` path
// uses the SQLite store + the Anthropic provider (needs a key) — the real path,
// exercised manually. Host-side.
import { makeLocalResolver } from "@iris/agent";
import { cmdInit, cmdBuild, cmdInspect, cmdVerify, cmdPush, cmdPull, cmdRun } from "./iris.ts";

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
    default:
      console.error("usage: iris <init|build|inspect|verify|push|pull|run>");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
