#!/usr/bin/env node
// The `iris` bin — a zero-dep argv dispatcher over the command functions
// (packages/demo/src/run.ts pattern). NOT unit-tested (the command fns are tested
// directly with injected deps); this wires real fs/host defaults. The `run` path
// uses the SQLite store + the Anthropic provider (needs a key) — the real path,
// exercised manually. Host-side.
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { readOciLayout, governingDigest } from "@iris/agent";
import { defaultBundle } from "@iris/core";
import type { Performer } from "@iris/core";
import { makeToolPerformer, makeToolRegistry, makeToolInvoker, makeSubprocessTransport } from "@iris/tools";
import type { ToolContract } from "@iris/tools";
import { cmdInit, cmdBuild, cmdInspect, cmdVerify, cmdPush, cmdPull, cmdRun, cmdServe, cmdDeploy } from "./iris.ts";
import { loadBundledTools } from "./tools.ts";
import { echoStreamingPerformer } from "./echo.ts";
import { runChat, wrapModelForImage, makeChatStreamingFakeModel, makeStreamSink } from "./chat.ts";
import {
  providerNameForModel,
  providerDescriptor,
  stripModelPrefix,
  loadModelProvider,
} from "./providers.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Discover the project's bundled tools for run/chat/serve. The tools dir defaults
// to the `tools/` SIBLING of the image layout (`iris build --out ./image` puts the
// image in the project, beside `tools/`), so it resolves regardless of CWD;
// `--tools <dir>` overrides. Returns a subprocess invoker over the discovered specs
// + the retrySafe names for the gate allowlist.
async function bundledToolWiring(
  argv: string[],
  layout: string,
): Promise<{ toolInvoker: ReturnType<typeof makeToolInvoker>; safeTools: string[] }> {
  const toolsDir = flag(argv, "--tools") ?? join(dirname(layout), "tools");
  const bundled = await loadBundledTools(toolsDir);
  return {
    toolInvoker: makeToolInvoker({ subprocess: makeSubprocessTransport(bundled.subprocessSpecs) }),
    safeTools: bundled.safeToolNames,
  };
}

async function runCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) throw new Error("usage: iris run <layoutdir> --session <id> [--db <path>] [--tools <dir>]");
  const session = flag(argv, "--session") ?? "default";
  const db = flag(argv, "--db") ?? ":memory:";
  // Real path (manual): SQLite store + the provider selected from the image's
  // model-id prefix (needs that provider's API key, e.g. ANTHROPIC_API_KEY /
  // OPENAI_API_KEY). The bare (prefix-stripped) model id is baked into the
  // performer since the harness model_call request carries no model.
  const sqlite = await import("@iris/store-sqlite");
  const image = await readOciLayout(layout);
  const provider = await loadModelProvider(providerNameForModel(image.lock.model.id));
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);
  const { toolInvoker, safeTools } = await bundledToolWiring(argv, layout);
  const outcome = await cmdRun(layout, {
    sessionId: session,
    store,
    scheduler,
    clock: { now: () => 0 },
    modelPerformer: provider.buffered({ model: stripModelPrefix(image.lock.model.id) }),
    toolInvoker,
    safeTools,
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
      "usage: iris serve <layoutdir> [--port N] [--host H] [--db path] [--model auto|anthropic|openai|echo] [--web]",
    );
  const port = Number(flag(argv, "--port") ?? 8787);
  const host = flag(argv, "--host") ?? "127.0.0.1";
  const db = flag(argv, "--db") ?? "./iris-serve.sqlite"; // a server wants durability (cf. run's :memory:)
  const modelOpt = flag(argv, "--model") ?? "auto";
  const web = argv.includes("--web"); // serve the web chat UI at GET /

  const sqlite = await import("@iris/store-sqlite");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);

  // The image's model-id prefix names the pinned provider (anthropic | openai).
  const image = await readOciLayout(layout);
  const pinned = providerNameForModel(image.lock.model.id);

  // Resolve which backend to serve. `auto` (default) uses the pinned provider when
  // its API key is present, else the no-key echo model so it is demoable.
  let resolved: "anthropic" | "openai" | "echo";
  if (modelOpt === "echo") {
    resolved = "echo";
  } else if (modelOpt === "anthropic" || modelOpt === "openai") {
    resolved = modelOpt;
  } else {
    const envKey = providerDescriptor(pinned).envKey;
    const hasKey = typeof process.env[envKey] === "string" && process.env[envKey] !== "";
    resolved = hasKey ? pinned : "echo";
  }

  let makeModelPerformer: (model: string, onDelta?: (t: string) => void) => Performer;
  if (resolved === "echo") {
    makeModelPerformer = (_model, onDelta): Performer => echoStreamingPerformer(onDelta);
  } else {
    const provider = await loadModelProvider(resolved);
    // cmdServe passes the PREFIXED image model id — strip it before the API call.
    makeModelPerformer = (model, onDelta): Performer =>
      provider.streaming({ model: stripModelPrefix(model), onDelta });
  }

  const { toolInvoker, safeTools } = await bundledToolWiring(argv, layout);
  const serve = await cmdServe(layout, {
    store,
    scheduler,
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer,
    port,
    host,
    web,
    toolInvoker,
    safeTools,
  });
  console.log(`iris serve: listening on ${serve.url} (model=${resolved}${web ? ", web=on" : ""})`);
  if (web) console.log("  GET  /                       — web chat UI (open in a browser)");
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
    throw new Error("usage: iris chat <layoutdir> --session <id> [--db <path>] [--tools <dir>] [--fake]");
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

  // Assemble performers (same shape as cmdRun): default bundle tactics (with the
  // bundled retrySafe tools allow-listed so a read-only tool call doesn't park on
  // approval), a lock-derived tool performer over the project's subprocess tools,
  // and a model performer (wrapped Anthropic, or the deterministic fake).
  const { toolInvoker, safeTools } = await bundledToolWiring(argv, layout);
  const bundle = defaultBundle({ safeTools });
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(makeToolRegistry(contracts), toolInvoker);

  // Select the provider from the image's model-id prefix; use that provider's key.
  const providerName = providerNameForModel(image.lock.model.id);
  const providerEnvKey = providerDescriptor(providerName).envKey;
  const hasKey =
    typeof process.env[providerEnvKey] === "string" && process.env[providerEnvKey] !== "";
  const useFake = forceFake || !hasKey;
  // The streaming sink writes live tokens to the SAME stdout the REPL renders to.
  // The model performer streams into `sink.onDelta`; `runChat` resets the sink per
  // turn and renders the streamed reply without re-printing it.
  const sink = makeStreamSink(process.stdout);
  let modelPerformer: Performer;
  if (useFake) {
    console.warn(
      forceFake
        ? "iris chat: --fake — using the deterministic (fake model); replies echo your input"
        : `iris chat: no ${providerEnvKey} — using the deterministic (fake model); replies echo your input`,
    );
    modelPerformer = makeChatStreamingFakeModel(sink.onDelta);
  } else {
    const provider = await loadModelProvider(providerName);
    // Stream tokens live; `wrapModelForImage` still injects model/system/maxTokens
    // (model prefix-stripped; request.model wins) and absorbs a provider error into
    // a synthetic reply (Finding B) so a failed model_call never poisons the journal.
    modelPerformer = wrapModelForImage(
      provider.streaming({ onDelta: sink.onDelta }),
      image,
    );
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
      streamSink: sink,
    });
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    store.close();
  }
}

// `iris deploy <layoutdir> [--out dir] [--name n] [--deploy]` — scaffold a Cloudflare
// Worker + Durable Object project (runs the capability-diff gate first). Scaffold-only
// by default; `--deploy` runs `wrangler deploy` but ONLY with IRIS_DEPLOY=1 (the real
// network egress is env-gated). Host-side.
async function deployCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) {
    throw new Error("usage: iris deploy <layoutdir> [--out dir] [--name n] [--deploy]");
  }
  const outDir = flag(argv, "--out") ?? "./iris-edge";
  const name = flag(argv, "--name");
  const wantDeploy = argv.includes("--deploy");

  let deploy: { run: (args: string[], cwd: string) => Promise<number> } | undefined;
  if (wantDeploy) {
    if (process.env.IRIS_DEPLOY !== "1") {
      throw new Error(
        "iris deploy --deploy: refusing to run `wrangler deploy` without IRIS_DEPLOY=1 — the real Cloudflare egress is env-gated. Omit --deploy to scaffold only.",
      );
    }
    const { spawn } = await import("node:child_process");
    // Pre-flight: refuse BEFORE cmdDeploy writes the scaffold if wrangler is absent
    // (strict gate-before-write, spec §3.2). The runner's onerror stays as a backstop.
    const wranglerAvailable = await new Promise<boolean>((resolve) => {
      const probe = spawn("wrangler", ["--version"], { stdio: "ignore" });
      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    });
    if (!wranglerAvailable) {
      throw new Error(
        "iris deploy --deploy: `wrangler` not found on PATH — install it (npm i -g wrangler) or omit --deploy to scaffold only.",
      );
    }
    deploy = {
      run: (args: string[], cwd: string): Promise<number> =>
        new Promise<number>((resolve, reject) => {
          const child = spawn("wrangler", args, { cwd, stdio: "inherit" });
          child.on("error", (e) =>
            reject(new Error(`iris deploy: cannot run wrangler (${e.message}); install it (npm i -g wrangler)`)),
          );
          child.on("close", (code) => resolve(code ?? 1));
        }),
    };
  }

  const result = await cmdDeploy(layout, {
    outDir,
    ...(name ? { name } : {}),
    ...(deploy ? { deploy } : {}),
  });
  for (const f of result.files) console.log(`iris deploy: wrote ${outDir}/${f}`);
  console.log(result.plan);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case "init": {
      const dir = argv[1] ?? ".";
      await cmdInit(dir);
      console.log(`iris: scaffolded ${dir}/ — agent.json, instructions.md, and a bundled tools/now tool`);
      console.log("next:");
      console.log(`  cd ${dir}`);
      console.log("  iris build --file agent.json --out ./image     # compile the agent image");
      console.log("  iris chat ./image --session s1 --db s1.sqlite --fake   # talk to it (no key needed)");
      console.log("  (set ANTHROPIC_API_KEY and drop --fake for a real model that calls the now tool)");
      break;
    }
    case "build": {
      const file = flag(argv, "--file") ?? "agent.json";
      // Resolve the project's bundled tools so scaffolded subprocess:// refs
      // resolve (default tools dir = <agent dir>/tools; --tools overrides).
      const toolsDir = flag(argv, "--tools") ?? join(dirname(file), "tools");
      const { resolver } = await loadBundledTools(toolsDir);
      const image = await cmdBuild({
        file,
        out: flag(argv, "--out") ?? "./image",
        resolver, // bundled tools resolve here; a real external registry is manual
      });
      console.log(JSON.stringify({ imageDigest: image.lock.imageDigest }));
      break;
    }
    case "inspect":
      console.log(JSON.stringify(await cmdInspect(argv[1]), null, 2));
      break;
    case "verify": {
      // verify re-resolves tool refs by ref — supply the same bundled resolver.
      const toolsDir = flag(argv, "--tools") ?? "tools";
      const { resolver } = await loadBundledTools(toolsDir);
      await cmdVerify(argv[1], { resolver });
      console.log("iris: verify ok");
      break;
    }
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
    case "deploy":
      await deployCommand(argv);
      break;
    default:
      console.error("usage: iris <init|build|inspect|verify|push|pull|run|serve|chat|deploy>");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
