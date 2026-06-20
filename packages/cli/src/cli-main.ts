#!/usr/bin/env node
// The `iris` bin — a zero-dep argv dispatcher over the command functions
// (packages/demo/src/run.ts pattern). NOT unit-tested (the command fns are tested
// directly with injected deps); this wires real fs/host defaults. The `run` path
// uses the SQLite store + the Anthropic provider (needs a key) — the real path,
// exercised manually. Host-side.
import { createInterface } from "node:readline";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readOciLayout, governingDigest, agentfileSchemaJson } from "@irisrun/agent";
import type { AgentImage } from "@irisrun/agent";
import { defaultBundle, harnessProgram } from "@irisrun/core";
import type { Performer, Json, StateStore, Scheduler } from "@irisrun/core";
import { makeToolPerformer, makeToolRegistry, makeToolInvoker, makeSubprocessTransport } from "@irisrun/tools";
import type { ToolContract } from "@irisrun/tools";
import { readFile } from "node:fs/promises";
import { cmdInit, cmdBuild, cmdInspect, cmdVerify, cmdPush, cmdPull, cmdRun, cmdServe, cmdDeploy, loadApprovalPolicy, type CliSubagents } from "./iris.ts";
import { cmdAudit } from "./audit-cmd.ts";
import { cmdJournalExport, cmdJournalVerify, cmdJournalImport } from "./journal-cmd.ts";
import { writeFile } from "node:fs/promises";
import { cmdEval, loadEvalSuite } from "./eval-cmd.ts";
import { cmdSchedule } from "./schedule-cmd.ts";
import { loadSubagents } from "./subagents-cfg.ts";
import { createApprovalInbox } from "@irisrun/auth";
import type { ApprovalPolicy, Principal } from "@irisrun/auth";
import { loadBundledTools } from "./tools.ts";
import { echoStreamingPerformer } from "./echo.ts";
import { runChat, wrapModelForImage, makeChatFakeModel, makeChatStreamingFakeModel, makeStreamSink } from "./chat.ts";
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

// Collect a REPEATABLE flag (e.g. `--role admin --role oncall`) into a string[].
// `flag` returns only the first occurrence; chat's `--role` needs all of them.
function flagAll(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
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

// The delegated task for a child: a `task` string in the call args, else the args JSON.
function taskFromArgs(args: Json): string {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const t = (args as { task?: Json }).task;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return JSON.stringify(args ?? {});
}

// Build the subagent wiring (P2-9) from the project's optional `subagents.json`
// (default beside the layout; `--subagents <file>` overrides). Each entry maps a
// delegate tool name → a child agent layout. Children are PRE-LOADED here (async) so
// the per-call `resolveChild` can be synchronous (makeSubagentPerformer calls it sync).
// The child shares the parent's store/scheduler family (its own derived sessionId), uses
// the child image's provider when its key is present, else the keyless fake echo. Returns
// undefined when no subagents are declared (byte-identical: no `subagent` effect).
async function buildSubagents(
  argv: string[],
  layout: string,
  store: StateStore,
  scheduler: Scheduler,
): Promise<CliSubagents | undefined> {
  const file = flag(argv, "--subagents") ?? join(dirname(layout), "subagents.json");
  const cfg = await loadSubagents(file);
  if (cfg.names.length === 0) return undefined;

  const baseDir = dirname(file);
  interface Child {
    image: AgentImage;
    model: Performer;
    toolInvoker: ReturnType<typeof makeToolInvoker>;
    safeTools: string[];
  }
  const children = new Map<string, Child>();
  for (const entry of cfg.entries) {
    // `image` is operator-authored (same trust as the Agentfile) and only READ via
    // readOciLayout (never executed), so a relative `..` is allowed here — unlike a
    // tool `exec` in tools.ts, which becomes an auto-spawned subprocess and is restricted.
    const childLayout = isAbsolute(entry.image) ? entry.image : join(baseDir, entry.image);
    const image = await readOciLayout(childLayout);
    const providerName = providerNameForModel(image.lock.model.id);
    const envKey = providerDescriptor(providerName).envKey;
    const hasKey = typeof process.env[envKey] === "string" && process.env[envKey] !== "";
    const model = hasKey
      ? (await loadModelProvider(providerName)).buffered({ model: stripModelPrefix(image.lock.model.id) })
      : makeChatFakeModel(); // keyless: a delegation still runs, echoing the task
    const bundled = await loadBundledTools(join(dirname(childLayout), "tools"));
    children.set(entry.name, {
      image,
      model,
      toolInvoker: makeToolInvoker({ subprocess: makeSubprocessTransport(bundled.subprocessSpecs) }),
      safeTools: bundled.safeToolNames,
    });
  }

  const makeResolveChild = (_parentSessionId: string) =>
    (call: { name: string; args: Json; childSessionId: string }) => {
      const c = children.get(call.name);
      if (!c) return null;
      const bundle = defaultBundle({ safeTools: c.safeTools });
      const contracts: ToolContract[] = c.image.lock.tools.map((t) => ({
        name: t.name,
        description: "",
        inputSchema: {},
        transport: t.transport,
        location: t.location,
        retrySafe: t.retrySafe,
      }));
      const toolPerformer = makeToolPerformer(makeToolRegistry(contracts), c.toolInvoker);
      return {
        host: { name: "iris-subagent", capabilities: { long_running: true, filesystem: true }, store, scheduler },
        defDigest: c.image.lock.imageDigest,
        program: harnessProgram({ messages: [{ role: "user", content: taskFromArgs(call.args) }] }),
        performers: { tactic: bundle.tacticPerformer, model_call: c.model, tool_call: toolPerformer },
        clock: { now: (): number => 0 },
        assertReplay: true,
      };
    };

  return { names: cfg.names, makeResolveChild };
}

async function runCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) throw new Error("usage: iris run <layoutdir> --session <id> [--db <path>] [--tools <dir>] [--subagents <file>]");
  const session = flag(argv, "--session") ?? "default";
  const db = flag(argv, "--db") ?? ":memory:";
  // Real path (manual): SQLite store + the provider selected from the image's
  // model-id prefix (needs that provider's API key, e.g. ANTHROPIC_API_KEY /
  // OPENAI_API_KEY). The bare (prefix-stripped) model id is baked into the
  // performer since the harness model_call request carries no model.
  const sqlite = await import("@irisrun/store-sqlite");
  const image = await readOciLayout(layout);
  const provider = await loadModelProvider(providerNameForModel(image.lock.model.id));
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);
  const { toolInvoker, safeTools } = await bundledToolWiring(argv, layout);
  const subagents = await buildSubagents(argv, layout, store, scheduler);
  const outcome = await cmdRun(layout, {
    sessionId: session,
    store,
    scheduler,
    clock: { now: () => 0 },
    modelPerformer: provider.buffered({ model: stripModelPrefix(image.lock.model.id) }),
    toolInvoker,
    safeTools,
    ...(subagents ? { subagents } : {}),
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
      "usage: iris serve <layoutdir> [--port N] [--host H] [--db path] [--model auto|anthropic|openai|echo] [--web] [--policy <file.json>] [--subagents <file>]",
    );
  const port = Number(flag(argv, "--port") ?? 8787);
  const host = flag(argv, "--host") ?? "127.0.0.1";
  const db = flag(argv, "--db") ?? "./iris-serve.sqlite"; // a server wants durability (cf. run's :memory:)
  const modelOpt = flag(argv, "--model") ?? "auto";
  const web = argv.includes("--web"); // serve the web chat UI at GET /

  // Opt-in governance (roadmap P1-5): --policy loads a who-may-approve policy + an
  // approval inbox. A client submits a decision via the message body's `approve:{…}`
  // field; the governed signal_recv performer reads it on the HITL resume, and every
  // approval is journaled (queryable with `iris audit`). Absent → ungoverned.
  const policyFile = flag(argv, "--policy");
  const governance = policyFile
    ? { policy: loadApprovalPolicy(await readFile(policyFile, "utf8"), `--policy ${policyFile}`), inbox: createApprovalInbox() }
    : undefined;

  const sqlite = await import("@irisrun/store-sqlite");
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
  const subagents = await buildSubagents(argv, layout, store, scheduler);
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
    ...(governance ? { governance } : {}),
    ...(subagents ? { subagents } : {}),
  });
  console.log(
    `iris serve: listening on ${serve.url} (model=${resolved}${web ? ", web=on" : ""}${governance ? ", governance=on" : ""})`,
  );
  if (governance)
    console.log(
      "  governance: submit an approval as a message body field — {\"approve\":{\"callId\":\"…\",\"name\":\"…\",\"principal\":{\"id\":\"…\",\"roles\":[…]},\"intent\":\"approve\"}}",
    );
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
    throw new Error("usage: iris chat <layoutdir> --session <id> [--db <path>] [--tools <dir>] [--subagents <file>] [--policy <file.json>] [--as <id>] [--role <r>] [--fake]");
  }
  const session = flag(argv, "--session") ?? "default";
  const db = flag(argv, "--db") ?? ":memory:";
  const forceFake = argv.includes("--fake");

  // In-chat HITL governance. A tool call gated to "ask" pauses for an inline y/n
  // approval. `--policy` loads a who-may-approve policy (identity-checked, journaled,
  // auditable with `iris audit`); without it, the local terminal user is the approver
  // (a permissive default policy, so an approve just runs the tool). The principal
  // stamps each decision; `--as`/`--role` override the local default.
  const policyFile = flag(argv, "--policy");
  const policy: ApprovalPolicy = policyFile
    ? loadApprovalPolicy(await readFile(policyFile, "utf8"), `--policy ${policyFile}`)
    : { rules: [], default: "permit" };
  const governance = { policy, inbox: createApprovalInbox() };
  const roleFlags = flagAll(argv, "--role");
  const principal: Principal = {
    id: flag(argv, "--as") ?? "local",
    roles: roleFlags.length ? roleFlags : ["operator"],
  };

  const sqlite = await import("@irisrun/store-sqlite");
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
  const subagents = await buildSubagents(argv, layout, store, scheduler);
  // Fold any delegate names into the SAME bundle the gate consults, so a delegation
  // auto-allows (not parks) — the kernel reads this one bundle's safeTools.
  const bundle = defaultBundle({ safeTools: [...safeTools, ...(subagents?.names ?? [])] });
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
    "Type a message and press enter; /exit, /quit, or Ctrl-D to leave (the session stays durable).\n" +
    `A non-safe tool call pauses for your approval — reply y (approve) or n (deny)` +
    `${policyFile ? ` (policy: ${policyFile}, as '${principal.id}')` : ""}.\n`;

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
      governance,
      principal,
      ...(subagents ? { subagents } : {}),
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

// `iris audit <session> --db <path> [--interactive] [--json]` — print a whole-session,
// compliance-grade audit (full retained journal + completeness) and a replay-verified
// verdict (roadmap P2-8). Reads a session recorded by a prior run/serve/chat. Host-side.
async function auditCommand(argv: string[]): Promise<void> {
  const session = argv[1];
  if (!session) {
    throw new Error("usage: iris audit <session> --db <path> [--interactive] [--json]");
  }
  const db = flag(argv, "--db") ?? ":memory:";
  if (db === ":memory:") {
    console.warn(
      "iris audit: --db :memory: — an in-memory store has no prior session; pass --db <path> from a previous run/serve/chat",
    );
  }
  const json = argv.includes("--json");
  const forceInteractive = argv.includes("--interactive"); // override journal auto-detection

  const sqlite = await import("@irisrun/store-sqlite");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  try {
    const { audit, verify, text } = await cmdAudit({
      store,
      sessionId: session,
      ...(forceInteractive ? { interactive: true } : {}),
    });
    if (json) console.log(JSON.stringify({ audit, verify }, null, 2));
    else console.log(text);
  } finally {
    store.close();
  }
}

// `iris eval <suite.mjs> [--reproduce <N>] [--json]` — run a reproducible eval suite
// (roadmap P2-8). The suite is a user MODULE exporting `cases` + `scorer`; we resolve
// its path to a file:// URL and import it (the loadBundledTools precedent for code the
// CLI must consume). `--reproduce N` proves each case byte-identical over N runs.
async function evalCommand(argv: string[]): Promise<void> {
  const suitePath = argv[1];
  if (!suitePath) {
    throw new Error("usage: iris eval <suite.mjs> [--reproduce <N>] [--json]");
  }
  const json = argv.includes("--json");
  const reproStr = flag(argv, "--reproduce");
  const reproduce = reproStr !== undefined ? Number(reproStr) : undefined;
  const moduleUrl = pathToFileURL(resolve(suitePath)).href;
  const suite = await loadEvalSuite(moduleUrl);
  const { results, reports, text } = await cmdEval(suite, {
    ...(reproduce !== undefined ? { reproduce } : {}),
    ...(json ? { json: true } : {}),
  });
  if (json) console.log(JSON.stringify(reports ?? results, null, 2));
  else console.log(text);
}

// `iris schedule <layout> --interval <ticks> --max-runs <n> [--ticks <n>] [--db <path>]
// [--session <id>]` — run a recurring, durably-replayable job (roadmap P2-9). The job is a
// keyless `echo` heartbeat (one effect per cycle) pinned to the agent image; it parks on a
// durable SQLite timer between cycles and the host-side pump resumes each due cycle. Prints
// one JSON line per committed cycle. Host-side.
async function scheduleCommand(argv: string[]): Promise<void> {
  const layout = argv[1];
  if (!layout) {
    throw new Error(
      "usage: iris schedule <layoutdir> --interval <ticks> --max-runs <n> [--ticks <n>] [--db <path>] [--session <id>]",
    );
  }
  const intervalTicks = Number(flag(argv, "--interval") ?? 10);
  const maxRuns = Number(flag(argv, "--max-runs") ?? 3);
  const ticks = Number(flag(argv, "--ticks") ?? maxRuns); // enough pump steps to complete
  if (Number.isInteger(ticks) && Number.isInteger(maxRuns) && ticks < maxRuns - 1) {
    console.warn(
      `iris schedule: --ticks ${ticks} < max-runs-1 (${maxRuns - 1}) — the schedule will not reach 'finished' this run (it parks for a later resume)`,
    );
  }
  const session = flag(argv, "--session") ?? "schedule";
  const db = flag(argv, "--db") ?? ":memory:";
  if (db === ":memory:") {
    console.warn("iris schedule: --db :memory: — the schedule won't persist; pass --db <path> for a durable, resumable job");
  }

  const sqlite = await import("@irisrun/store-sqlite");
  const handle = sqlite.openDatabase(db);
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);
  const image = await readOciLayout(layout); // pin the schedule's def to the agent image

  try {
    const result = await cmdSchedule({
      host: { name: "iris-schedule", capabilities: { long_running: true }, store, scheduler },
      source: scheduler,
      sessionId: session,
      intervalTicks,
      maxRuns,
      ticks,
      job: { effectKind: "echo", request: { tick: true } },
      cyclePerformers: (now: number): Record<string, Performer> => ({
        clock: async () => ({ ok: true, value: now }),
        echo: async (r: Json) => ({ ok: true, value: r }),
      }),
      defDigest: image.lock.imageDigest,
    });
    console.log(result.text);
  } finally {
    store.close();
  }
}

// `iris journal <export|verify|import>` — the verifiable portable journal
// (roadmap-v0.2 P0). A `journal` subcommand group because `iris verify` already
// means OCI image verification. export/import open a SQLite store; verify is
// file-only (Tier 1) with an optional `--replay` (Tier 2) and `--image` pin.
// Wires real fs/sqlite IO; the cmdJournal* logic is unit-tested with injected deps.
async function journalCommand(argv: string[]): Promise<void> {
  const sub = argv[1];
  if (sub === "export") {
    const session = argv[2];
    const db = flag(argv, "--store") ?? flag(argv, "--db");
    const out = flag(argv, "--out");
    if (!session || !db || !out) {
      throw new Error("usage: iris journal export <session> --store <db> --out <file>");
    }
    const sqlite = await import("@irisrun/store-sqlite");
    const handle = sqlite.openDatabase(db);
    const store = new sqlite.SqliteStateStore(handle);
    try {
      const { bytes, text } = await cmdJournalExport({ store, sessionId: session });
      await writeFile(out, bytes);
      console.log(text);
      console.log(`written ${out}`);
    } finally {
      store.close();
    }
    return;
  }
  if (sub === "verify") {
    const file = argv[2];
    if (!file || file.startsWith("--")) {
      throw new Error("usage: iris journal verify <file> [--replay] [--image <layoutdir>] [--json]");
    }
    const bytes = new Uint8Array(await readFile(file));
    const imageDir = flag(argv, "--image");
    let expectDefDigest: string | undefined;
    if (imageDir) expectDefDigest = (await readOciLayout(imageDir)).lock.imageDigest;
    const { exitCode, result, text } = cmdJournalVerify({
      bytes,
      replay: argv.includes("--replay"),
      ...(expectDefDigest !== undefined ? { expectDefDigest } : {}),
    });
    if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(text);
    process.exit(exitCode);
  }
  if (sub === "import") {
    const file = flag(argv, "--in");
    const db = flag(argv, "--store") ?? flag(argv, "--db");
    if (!file || !db) {
      throw new Error("usage: iris journal import --in <file> --store <db>");
    }
    const bytes = new Uint8Array(await readFile(file));
    const sqlite = await import("@irisrun/store-sqlite");
    const handle = sqlite.openDatabase(db);
    const store = new sqlite.SqliteStateStore(handle);
    try {
      const { text } = await cmdJournalImport({ store, bytes });
      console.log(text);
    } finally {
      store.close();
    }
    return;
  }
  console.error("usage: iris journal <export|verify|import>");
  process.exit(2);
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
    case "schema":
      // Print the published Agentfile JSON Schema (draft 2020-12). Pipe to a file
      // for editor/CI validation: `iris schema > agentfile.schema.json`.
      console.log(agentfileSchemaJson());
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
    case "audit":
      await auditCommand(argv);
      break;
    case "eval":
      await evalCommand(argv);
      break;
    case "schedule":
      await scheduleCommand(argv);
      break;
    case "journal":
      await journalCommand(argv);
      break;
    default:
      console.error("usage: iris <init|build|inspect|schema|verify|push|pull|run|serve|chat|deploy|audit|eval|schedule|journal>");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
