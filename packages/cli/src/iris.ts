// iris CLI command functions (spec §3.8). Each is a thin shell over @iris/agent +
// @iris/core, with deps INJECTED so they are unit-testable without a registry, a
// real model, or Docker. The argv dispatcher (cli-main.ts) wires real fs/host
// defaults. Host-side; zero external deps (only node: builtins + workspace pkgs).
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { runTurn, harnessProgram, defaultBundle } from "@iris/core";
import type {
  Performer,
  StateStore,
  Scheduler,
  LogicalClock,
  HarnessInput,
  HarnessState,
  TurnOutcome,
  Json,
} from "@iris/core";
import { makeToolPerformer, makeToolRegistry, makeToolInvoker } from "@iris/tools";
import type { ToolContract } from "@iris/tools";
import {
  parseAgentfileJson,
  parseAgentfileYaml,
  buildImage,
  inspectImage,
  writeOciLayout,
  readOciLayout,
  verifyImage,
  governingDigest,
} from "@iris/agent";
import type { AgentImage, ImageInspection, RegistryResolver, CapabilityProfile } from "@iris/agent";
import { makeRestChannel, type StreamEvent } from "@iris/channel-rest";
import { makeWebHandler } from "@iris/channel-web";
import { assertDeployable, type HostAdapter } from "@iris/host";
import { edgeHost, type DoStorage } from "@iris/store-do";

// --- 9a: init / build / inspect / verify -------------------------------------

const SCAFFOLD_AGENT = {
  apiVersion: "iris/v1",
  kind: "Agent",
  name: "my-agent",
  model: "anthropic/claude-x",
  instructions: "./instructions.md",
  skills: [] as string[],
  tools: [] as { ref: string }[],
  connections: [] as { ref: string }[],
  harness: { bundle: "default" },
  requires: { tool_locality: "remote" },
  sandbox: { backend: "inmemory", network: "deny-all" },
};

export async function cmdInit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent.json"), `${JSON.stringify(SCAFFOLD_AGENT, null, 2)}\n`);
  await writeFile(join(dir, "instructions.md"), "# Instructions\n\nYou are a helpful agent.\n");
}

export interface CliBuildOptions {
  file: string;
  out: string;
  resolver: RegistryResolver;
  readFile?: (path: string) => Promise<Uint8Array>;
}

export async function cmdBuild(opts: CliBuildOptions): Promise<AgentImage> {
  const text = await readFile(opts.file, "utf8");
  const model =
    opts.file.endsWith(".yaml") || opts.file.endsWith(".yml")
      ? parseAgentfileYaml(text)
      : parseAgentfileJson(text);
  const root = dirname(opts.file);
  const rf =
    opts.readFile ?? ((p: string) => readFile(join(root, p)).then((b) => new Uint8Array(b)));
  const image = await buildImage(model, { resolver: opts.resolver, readFile: rf });
  await writeOciLayout(opts.out, image);
  return image;
}

export async function cmdInspect(layoutdir: string): Promise<ImageInspection> {
  return inspectImage(await readOciLayout(layoutdir));
}

export async function cmdVerify(
  layoutdir: string,
  opts: { resolver: RegistryResolver },
): Promise<void> {
  await verifyImage(await readOciLayout(layoutdir), { resolver: opts.resolver });
}

// --- 9b: push / pull (local OCI layout; real registry = manual smoke) ---------

export async function cmdPush(layoutdir: string, dest: string): Promise<void> {
  await cp(layoutdir, dest, { recursive: true });
}

export async function cmdPull(src: string, layoutdir: string): Promise<void> {
  await cp(src, layoutdir, { recursive: true });
}

// --- 9c: run (assemble performers from the lock; pin = held ?? layout) ---------

export interface CliRunOptions {
  sessionId: string;
  store: StateStore;
  scheduler: Scheduler;
  clock: LogicalClock;
  modelPerformer: Performer; // fake install-free; a real provider in production
  input?: HarnessInput;
  onWarn?: (message: string) => void;
}

export async function cmdRun(
  layoutdir: string,
  opts: CliRunOptions,
): Promise<TurnOutcome<HarnessState>> {
  const image = await readOciLayout(layoutdir);
  const held = await governingDigest(opts.store, opts.sessionId);
  // Surface a held-pin-vs-layout mismatch — never silently override (migration is
  // the only sanctioned way to change a live pin).
  if (held !== null && held !== image.lock.imageDigest) {
    (opts.onWarn ?? console.warn)(
      `iris run: session '${opts.sessionId}' holds pin ${held} ≠ layout ${image.lock.imageDigest}; running under the HELD pin (use a definition migration to change it)`,
    );
  }
  const defDigest = held ?? image.lock.imageDigest;

  const bundle = defaultBundle();
  // Reconstruct minimal contracts from the lock for dispatch (description/
  // inputSchema are model-perceived only — not needed to INVOKE). No transports
  // are wired here: install-free runs use a fake model that calls no tools.
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(makeToolRegistry(contracts), makeToolInvoker({}));

  return runTurn(
    {
      store: opts.store,
      scheduler: opts.scheduler,
      clock: opts.clock,
      program: harnessProgram(opts.input ?? { messages: [{ role: "user", content: "hi" }] }),
      performers: {
        tactic: bundle.tacticPerformer,
        model_call: opts.modelPerformer,
        tool_call: toolPerformer,
      },
      defDigest,
      holderId: "iris-run",
      assertReplay: true,
    },
    opts.sessionId,
  );
}

// --- 9d: serve (turnkey HTTP server: buffered REST + streaming SSE + WS) -------

function bodyToInput(body: Json): HarnessInput {
  const b = body as { messages?: { role: string; content: string }[] };
  return Array.isArray(b.messages) && b.messages.length > 0
    ? { messages: b.messages }
    : { messages: [{ role: "user", content: "hi" }] };
}

export interface CliServeOptions {
  store: StateStore;
  scheduler: Scheduler;
  capabilities: CapabilityProfile; // a real server: long_running + filesystem + websockets
  // Builds the model_call performer per turn, bound to that request's delta sink.
  // `model` is the image's pinned model id (the harness request carries none).
  makeModelPerformer: (model: string, onDelta?: (t: string) => void) => Performer;
  port?: number; // default 8787
  host?: string; // default 127.0.0.1
  clock?: LogicalClock; // default { now: () => 0 }
  onWarn?: (message: string) => void;
  web?: boolean; // serve the @iris/channel-web chat UI at GET / (same port)
}

export interface ServeHandle {
  url: string;
  close(): Promise<void>;
}

// Assemble a host + the streaming channel from an image and listen. The channel
// MINTS sessionIds and OWNS the rotating single-use continuationToken; a turn's
// journal records stream as SSE/WS `record` events and the model's tokens as
// `delta` events (host-side; the real sqlite + Anthropic path is a manual smoke).
export async function cmdServe(layoutdir: string, opts: CliServeOptions): Promise<ServeHandle> {
  const image = await readOciLayout(layoutdir);
  const modelId = image.lock.model.id; // the harness model_call request has no model
  const bundle = defaultBundle();
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));
  const clock = opts.clock ?? { now: (): number => 0 };

  // Reconstruct tool contracts from the lock for dispatch (same as cmdRun).
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(makeToolRegistry(contracts), makeToolInvoker({}));

  const channel = makeRestChannel<HarnessState>({
    adapter: {
      name: "iris-serve",
      capabilities: opts.capabilities,
      store: opts.store,
      scheduler: opts.scheduler,
    },
    // Serve the web chat UI at GET / when requested (the channel-web seam); the API
    // (POST /v1/*) and the WS upgrade are untouched.
    ...(opts.web ? { webHandler: makeWebHandler() } : {}),
    makeTurnInputs: async (sessionId: string, body: Json, emit?: (ev: StreamEvent) => void) => {
      // Resolve the HELD pin per turn (never silently override it — same posture as
      // cmdRun); the channel is multi-session so this is per-(session, turn).
      const held = await governingDigest(opts.store, sessionId);
      if (held !== null && held !== image.lock.imageDigest) {
        onWarn(
          `iris serve: session '${sessionId}' holds pin ${held} ≠ layout ${image.lock.imageDigest}; running under the HELD pin (use a definition migration to change it)`,
        );
      }
      const defDigest = held ?? image.lock.imageDigest;
      const onDelta = emit ? (t: string): void => emit({ type: "delta", text: t }) : undefined;
      return {
        program: harnessProgram(bodyToInput(body)),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: opts.makeModelPerformer(modelId, onDelta),
          tool_call: toolPerformer,
        },
        clock,
        defDigest,
      };
    },
  });

  const url = await channel.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1");
  return { url, close: (): Promise<void> => channel.close() };
}

// --- 9e: deploy (Cloudflare Durable Objects — the supported one-command path) -------
//
// Promotes the edge target from a hand-edited manual smoke
// (manual/cloudflare-workers-smoke.ts) to a turnkey, TESTED command: read the image,
// run the M6 capability-diff gate (assertDeployable) and refuse an over-capable image
// LOUDLY (ADR-0008) BEFORE writing anything, then scaffold a self-contained Worker
// project (wrangler.toml + worker.mjs generalizing the smoke's inline DO class).
// The terminal `wrangler deploy` network egress stays ENV-GATED (operator-installed
// wrangler + a real Cloudflare account) — like push/pull's "real registry = manual" —
// so the install-free / zero-runtime-dep invariant holds.

export interface CliDeployOptions {
  // The edge target (capabilities + name). Defaults to the canonical Cloudflare DO
  // profile via edgeHost; the gate reads only .name/.capabilities (never the store).
  host?: HostAdapter;
  outDir: string;
  name?: string; // wrangler worker name (default: the image's agent name, sanitized)
  compatibilityDate?: string;
  writeFile?: (path: string, data: string) => Promise<void>; // injected; default fs
  mkdir?: (path: string) => Promise<void>;
  // env-gated wrangler runner; absent = scaffold-only (print the plan, don't deploy).
  deploy?: { run: (args: string[], cwd: string) => Promise<number> };
}

export interface DeployResult {
  outDir: string;
  files: string[];
  deployed: boolean;
  plan: string;
}

const DEFAULT_COMPAT_DATE = "2026-01-01";

// A DoStorage that THROWS if used — edgeHost wires it into a DoStateStore/DoScheduler
// the deploy gate never touches (it reads only host.name/.capabilities). Refuse
// loudly if any path actually reaches it (no silent fake storage).
function noopDoStorage(): DoStorage {
  const fail = (): never => {
    throw new Error("iris deploy: edge storage is not available at scaffold time");
  };
  const s = {
    get: fail,
    put: fail,
    delete: fail,
    list: fail,
    transaction: fail,
    setAlarm: fail,
    getAlarm: fail,
  };
  return s as unknown as DoStorage;
}

// Strip a leading `<provider>/` segment from a model id ("anthropic/claude-x" →
// "claude-x"); idempotent for an already-bare id.
function stripModelPrefix(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

// wrangler worker names: lowercase alphanumerics + hyphens.
function sanitizeName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "iris-agent" : s;
}

function wranglerToml(name: string, compatDate: string): string {
  return [
    `name = "${name}"`,
    `main = "worker.mjs"`,
    `compatibility_date = "${compatDate}"`,
    ``,
    `# The agent's durable state lives in this Durable Object (single-writer lease +`,
    `# transactional storage + alarms = sleepUntil). @iris/core + @iris/store-do are`,
    `# edge-native (node:-free, Web btoa/atob), so no nodejs_compat flag is needed.`,
    `[[durable_objects.bindings]]`,
    `name = "AGENT"`,
    `class_name = "AgentDO"`,
    ``,
    `[[migrations]]`,
    `tag = "v1"`,
    `new_classes = ["AgentDO"]`,
    ``,
  ].join("\n");
}

function workerMjs(model: string, defDigest: string): string {
  const M = JSON.stringify(model);
  const D = JSON.stringify(defDigest);
  return `// GENERATED by \`iris deploy\` — a Cloudflare Worker + Durable Object running the
// SAME @iris/core unchanged on workerd (generalizes manual/cloudflare-workers-smoke.ts).
// Bundled by wrangler/esbuild on deploy; core is node:-free so it targets the isolate.
import { edgeHost } from "@iris/store-do";
import { harnessProgram, defaultBundle } from "@iris/core";
import { runTurnOn } from "@iris/host";

const MODEL = ${M};
const DEF_DIGEST = ${D};

// Adapt a real Cloudflare DurableObjectStorage to @iris/store-do's narrow DoStorage
// (inlined from the smoke's doStorageAdapter so the worker is self-contained).
function doStorageAdapter(storage) {
  const wrap = (s) => ({
    async get(key) { return (await s.get(key, { allowConcurrency: false })) ?? undefined; },
    async put(key, value) { await s.put(key, value); },
    async delete(key) { return await s.delete(key); },
    async list(opts) { return await s.list(opts && opts.prefix ? { prefix: opts.prefix } : undefined); },
    transaction(fn) { return s.transaction((txn) => fn(wrap(txn))); },
    async setAlarm(t) { await s.setAlarm(t); },
    async getAlarm() { return await s.getAlarm(); },
  });
  return wrap(storage);
}

async function runOneTurn(state, env, sessionId, input) {
  const host = edgeHost(doStorageAdapter(state.storage));
  const bundle = defaultBundle({ safeTools: [] });
  const program = harnessProgram(input, { invariants: bundle.invariants });
  // A real model when ANTHROPIC_API_KEY is set (provider-anthropic is fetch-based;
  // dynamic import keeps it out of the no-key path), else an inline echo.
  let model_call;
  if (env && env.ANTHROPIC_API_KEY) {
    const { anthropicModelPerformer } = await import("@iris/provider-anthropic");
    model_call = anthropicModelPerformer({ apiKey: env.ANTHROPIC_API_KEY, model: MODEL });
  } else {
    model_call = async () => ({ ok: true, value: { role: "assistant", content: "echo (set ANTHROPIC_API_KEY for a real model)", stopReason: "end_turn" } });
  }
  const performers = { tactic: bundle.tacticPerformer, model_call };
  return runTurnOn(host, { sessionId, defDigest: DEF_DIGEST, program, performers, clock: { now: () => Date.now() }, assertReplay: true });
}

export class AgentDO {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session") || "default";
    let input = { messages: [{ role: "user", content: "hi" }] };
    if (req.method === "POST") {
      try { const b = await req.json(); if (b && Array.isArray(b.messages) && b.messages.length) input = { messages: b.messages }; } catch {}
    }
    const out = await runOneTurn(this.state, this.env, sessionId, input);
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }
  // A DO alarm IS sleepUntil: on a scheduled wake, run a turn so the engine resumes a
  // parked timer-wait. Best-effort — the durable timer records remain authoritative.
  async alarm() { await runOneTurn(this.state, this.env, "default", { messages: [] }); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const session = url.searchParams.get("session") || "default";
    const id = env.AGENT.idFromName(session);
    return env.AGENT.get(id).fetch(req);
  },
};
`;
}

export async function cmdDeploy(layoutdir: string, opts: CliDeployOptions): Promise<DeployResult> {
  const image = await readOciLayout(layoutdir);
  const host = opts.host ?? edgeHost(noopDoStorage());

  // GATE (ADR-0008): refuse an over-capable image LOUDLY, BEFORE writing anything.
  assertDeployable(image.lock.capabilities, host);

  const name = sanitizeName(opts.name ?? image.agentfile.name ?? "iris-agent");
  const compatDate = opts.compatibilityDate ?? DEFAULT_COMPAT_DATE;
  // Strip the `<provider>/` prefix: image.lock.model.id is e.g. "anthropic/claude-x",
  // but the Anthropic API wants the bare "claude-x" (cf. wrapModelForImage). The
  // worker bakes this into anthropicModelPerformer({ model }) for the real-key path.
  const model = stripModelPrefix(image.lock.model.id);
  const defDigest = image.lock.imageDigest;

  const writeFileImpl = opts.writeFile ?? ((p: string, d: string): Promise<void> => writeFile(p, d));
  const mkdirImpl =
    opts.mkdir ??
    (async (p: string): Promise<void> => {
      await mkdir(p, { recursive: true });
    });

  await mkdirImpl(opts.outDir);
  await writeFileImpl(join(opts.outDir, "wrangler.toml"), wranglerToml(name, compatDate));
  await writeFileImpl(join(opts.outDir, "worker.mjs"), workerMjs(model, defDigest));
  const files = ["wrangler.toml", "worker.mjs"];

  let deployed = false;
  if (opts.deploy) {
    const code = await opts.deploy.run(["deploy"], opts.outDir);
    if (code !== 0) throw new Error(`iris deploy: \`wrangler deploy\` exited with code ${code}`);
    deployed = true;
  }

  const plan = deployed
    ? `iris deploy: deployed '${name}' to ${host.name} (wrangler deploy)`
    : `iris deploy: scaffolded a ${host.name} Worker for '${name}' in ${opts.outDir}.\n` +
      `  To deploy: cd ${opts.outDir} && wrangler deploy  (needs a Cloudflare account + wrangler; set ANTHROPIC_API_KEY as a secret for a real model)`;
  return { outDir: opts.outDir, files, deployed, plan };
}
