// iris CLI command functions. Each is a thin shell over @irisrun/agent +
// @irisrun/core, with deps INJECTED so they are unit-testable without a registry, a
// real model, or Docker. The argv dispatcher (cli-main.ts) wires real fs/host
// defaults. Host-side; zero external deps (only node: builtins + workspace pkgs).
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { runTurn, harnessProgram, defaultBundle } from "@irisrun/core";
import type {
  Performer,
  StateStore,
  Scheduler,
  LogicalClock,
  HarnessInput,
  HarnessState,
  TurnOutcome,
  Json,
} from "@irisrun/core";
import { makeToolPerformer, makeToolRegistry, makeToolInvoker } from "@irisrun/tools";
import type { ToolContract, ToolInvoker } from "@irisrun/tools";
import {
  parseAgentfileJson,
  parseAgentfileYaml,
  buildImage,
  inspectImage,
  writeOciLayout,
  readOciLayout,
  verifyImage,
  governingDigest,
} from "@irisrun/agent";
import type { AgentImage, ImageInspection, RegistryResolver, CapabilityProfile } from "@irisrun/agent";
import type { StreamEvent } from "@irisrun/channel-rest";
import { makeWebHandler } from "@irisrun/channel-web";
import { resolveChannel } from "./channel.ts";
import { resolveBridge } from "./bridge.ts";
import { makePlatformBridge, type PlatformBridge } from "@irisrun/bridge";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assertDeployable } from "@irisrun/host";
import {
  getTarget,
  noopHostFor,
  DEFAULT_COMPAT_DATE,
  IRIS_VERSION,
  type ScaffoldContext,
} from "./deploy-targets.ts";
import {
  providerNameForModel,
  providerDescriptor,
  stripModelPrefix,
} from "./providers.ts";
import { makeGovernedApprovalPerformer } from "@irisrun/auth";
import type { ApprovalPolicy, ApprovalInbox, Principal, RawApproval } from "@irisrun/auth";
import { makeSubagentPerformer } from "@irisrun/subagents";
import type { SubagentPerformerDeps } from "@irisrun/subagents";

// Opt-in governance: when a policy + inbox are configured, register the
// governed `signal_recv` performer so the HITL gate becomes policy-checked and
// identity-stamped, and every approval is journaled for audit. Zero-value-off: absent
// governance → {} → the performer registry is BYTE-IDENTICAL to the ungoverned default
// (no `signal_recv` key). Shared by cmdRun + cmdServe.
export function governancePerformers(
  governance?: { policy: ApprovalPolicy; inbox: ApprovalInbox },
): { signal_recv?: Performer } {
  return governance ? { signal_recv: makeGovernedApprovalPerformer(governance) } : {};
}

// Opt-in subagent delegation. `names` are the delegate tool names the
// kernel routes as `subagent` effects (passed to harnessProgram as subagentTools AND
// gate-allowed via safeTools); `makeResolveChild` builds the per-(parent-session)
// resolver the host runs the child agent with. Absent → no `subagent` effect, no
// subagentTools (byte-identical to today). Shared by cmdRun + cmdServe.
export interface CliSubagents {
  names: string[];
  makeResolveChild: (parentSessionId: string) => SubagentPerformerDeps["resolveChild"];
}

export function subagentPerformers(
  subagents: CliSubagents | undefined,
  parentSessionId: string,
): { subagent?: Performer } {
  return subagents
    ? { subagent: makeSubagentPerformer({ parentSessionId, resolveChild: subagents.makeResolveChild(parentSessionId) }) }
    : {};
}

// Parse + validate a `--policy <file>` JSON document into an ApprovalPolicy. LOUD on
// any malformation — a bad policy must NEVER silently fall back to ungoverned (that
// would be silent policy widening). The testable seam serveCommand wires (cli-main.ts
// does the real readFile). `source` only enriches error messages.
export function loadApprovalPolicy(text: string, source = "--policy"): ApprovalPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`iris ${source}: policy file is not valid JSON — ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`iris ${source}: policy must be a JSON object with a "rules" array`);
  }
  const o = raw as { rules?: unknown; default?: unknown };
  if (!Array.isArray(o.rules)) {
    throw new Error(`iris ${source}: policy "rules" must be an array (got ${typeof o.rules})`);
  }
  if (o.default !== undefined && o.default !== "deny" && o.default !== "permit") {
    throw new Error(`iris ${source}: policy "default" must be "deny" or "permit" (got ${JSON.stringify(o.default)})`);
  }
  // Rules are validated structurally by @irisrun/auth's `authorize` at decision time
  // (each field is optional); we guard only the envelope here.
  return o as ApprovalPolicy;
}

// When governance is configured, a continue-message body MAY carry an approval
// decision: `approve: { callId, name, principal, intent }`. Submit it to the shared
// inbox BEFORE the turn runs, so the governed signal_recv performer reads it on the
// HITL resume. A malformed `approve` is a client error — warn and skip (never crash
// the turn); an absent field is the normal (non-approval) case. Returns silently.
function submitApprovalFromBody(
  inbox: ApprovalInbox,
  body: Json,
  onWarn: (m: string) => void,
): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const approve = (body as { approve?: Json }).approve;
  if (approve === undefined) return; // the common case: an ordinary message
  if (approve === null || typeof approve !== "object" || Array.isArray(approve)) {
    onWarn("iris serve: ignoring malformed `approve` body (must be an object)");
    return;
  }
  const a = approve as { callId?: Json; name?: Json; principal?: Json; intent?: Json };
  if (typeof a.callId !== "string" || a.callId === "" || typeof a.name !== "string" || a.name === "") {
    onWarn("iris serve: ignoring `approve` body without non-empty string callId + name");
    return;
  }
  if (a.intent !== "approve" && a.intent !== "deny") {
    onWarn(`iris serve: ignoring \`approve\` body with intent ${JSON.stringify(a.intent)} (want "approve"|"deny")`);
    return;
  }
  if (a.principal === null || typeof a.principal !== "object" || Array.isArray(a.principal) || typeof (a.principal as { id?: Json }).id !== "string") {
    onWarn("iris serve: ignoring `approve` body without a principal {id:string, roles?:string[]}");
    return;
  }
  // Guard `roles` too — a non-array would throw in `authorize` (roles.includes) at the
  // HITL resume. This is the untrusted-HTTP-body boundary: validate, don't trust.
  const roles = (a.principal as { roles?: Json }).roles;
  if (roles !== undefined && (!Array.isArray(roles) || !roles.every((r) => typeof r === "string"))) {
    onWarn("iris serve: ignoring `approve` body whose principal.roles is not a string[]");
    return;
  }
  inbox.submit({ name: a.name, callId: a.callId }, { principal: a.principal as Principal, intent: a.intent });
}

// --- 9a: init / build / inspect / verify -------------------------------------

// The scaffold is a SELF-CONTAINED project, not an empty folder (the
// "exile cliff" fix): it ships a bundled `now` tool the agent can call with no
// external server. An Agentfile cannot author an in-process tool (CONTRACT_SCHEMES
// = mcp|grpc|subprocess), so the bundled tool is a SUBPROCESS
// tool — a small script beside the Agentfile, discovered by loadBundledTools.
const SCAFFOLD_AGENT = {
  apiVersion: "iris/v1",
  kind: "Agent",
  name: "my-agent",
  model: "anthropic/claude-x",
  instructions: "./instructions.md",
  skills: [] as string[],
  tools: [{ ref: "subprocess://now" }] as { ref: string }[],
  connections: [] as { ref: string }[],
  harness: { bundle: "default" },
  // A subprocess tool needs local_subprocess (lock.ts validateCapabilities); a
  // "local" locality (NOT "remote", which forbids subprocess tools).
  requires: { local_subprocess: true, tool_locality: "local" },
  sandbox: { backend: "inmemory", network: "deny-all" },
};

const SCAFFOLD_INSTRUCTIONS = `# Instructions

You are a helpful agent.

You have a \`now\` tool that returns the current date and time. Call it whenever
the user asks what time or date it is — a language model cannot know the current
time on its own, so use the tool rather than guessing.

Every tool result is recorded in this session's durable journal, so replaying the
session reproduces the exact time the tool returned: your runs stay deterministic
even though the clock keeps moving.
`;

const STARTER_TOOL_DESCRIPTOR = {
  ref: "subprocess://now",
  name: "now",
  description: "Return the current date and time. Use this whenever the user asks what time or date it is.",
  inputSchema: {
    type: "object",
    properties: {
      tz: {
        type: "string",
        description: 'Optional IANA timezone, e.g. "UTC" or "America/New_York". Defaults to UTC.',
      },
    },
  },
  retrySafe: true,
  exec: "now.mjs",
};

// A zero-dependency starter tool. Speaks the Iris subprocess line protocol: read
// ONE {id,name,input} JSON line on stdin, write ONE {id,ok,value|error} line on
// stdout, exit 0. Returns the current time — the canonical "a model can't know
// this" tool. An invalid `tz` fails cleanly with code "bad_tz" (no crash/hang).
const STARTER_TOOL_JS = `// GENERATED by \`iris init\` — a bundled, zero-dependency starter tool.
// Subprocess line protocol: one JSON request line in, one JSON response line out.
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  let req;
  try {
    req = JSON.parse(buf.slice(0, nl));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: "malformed request line", code: "bad_request" } }) + "\\n");
    process.exit(0);
  }
  const input = req && typeof req.input === "object" && req.input ? req.input : {};
  const tz = typeof input.tz === "string" && input.tz.length > 0 ? input.tz : "UTC";
  const now = new Date();
  try {
    // Validate the timezone (an invalid zone throws a RangeError).
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now);
    const value = { iso: now.toISOString(), unixMs: now.getTime(), tz };
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, value }) + "\\n");
  } catch {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { message: "invalid timezone: " + tz, code: "bad_tz" } }) + "\\n");
  }
  process.exit(0);
});
`;

// The YAML authoring of SCAFFOLD_AGENT (initiative 20260620-agentfile-env-secrets).
// Parses to the SAME model as the JSON scaffold (`skills: []`/`connections: []` use
// the empty-flow literal the YAML reader now supports). Ships `secrets:`/
// `environment:` examples COMMENTED OUT, so the default scaffolded agent declares
// neither and stays in legacy mode (byte-compatible). Uncommenting opts into the
// least-privilege env scoping; secret VALUES are supplied at run time, never here.
const SCAFFOLD_AGENT_YAML = `# Iris Agentfile (authored in YAML). Build with: iris build  (auto-detects agent.yaml)
apiVersion: iris/v1
kind: Agent
name: my-agent
model: anthropic/claude-x
instructions: ./instructions.md
skills: []
tools:
  - ref: subprocess://now
connections: []
harness:
  bundle: default
# A subprocess tool needs local_subprocess; a "local" (not "remote") locality.
requires:
  local_subprocess: true
  tool_locality: local
sandbox:
  backend: inmemory
  network: deny-all
# Secrets & environment (optional). \`secrets\` are NAMES only — supply VALUES at run
# time with --env-file / --env (NEVER commit a secret value). \`environment\` are
# non-secret literal defaults. A subprocess tool then sees ONLY the declared env
# plus a fixed PATH/HOME base (least-privilege). Uncomment to use:
# secrets:
#   - GITHUB_TOKEN
# environment:
#   LOG_LEVEL: info
`;

// Scaffold a self-contained agent project: agent.{yaml|json} + instructions.md + a
// bundled `tools/now.{mjs,tool.json}` the agent can call immediately. The DEFAULT is
// YAML (self-documenting — JSON cannot carry the commented secrets/environment
// examples); `json: true` authors JSON. Both formats are first-class to `iris build`.
export async function cmdInit(dir: string, opts: { json?: boolean } = {}): Promise<void> {
  await mkdir(join(dir, "tools"), { recursive: true }); // also creates `dir`
  if (opts.json) {
    await writeFile(join(dir, "agent.json"), `${JSON.stringify(SCAFFOLD_AGENT, null, 2)}\n`);
  } else {
    await writeFile(join(dir, "agent.yaml"), SCAFFOLD_AGENT_YAML);
  }
  await writeFile(join(dir, "instructions.md"), SCAFFOLD_INSTRUCTIONS);
  await writeFile(join(dir, "tools", "now.mjs"), STARTER_TOOL_JS);
  await writeFile(join(dir, "tools", "now.tool.json"), `${JSON.stringify(STARTER_TOOL_DESCRIPTOR, null, 2)}\n`);
}

export interface ResolveBuildFileResult {
  file: string;
  warning?: string;
}

/**
 * Pick the default Agentfile when `iris build` runs without `--file`: the first
 * existing of `agent.json`, `agent.yaml`, `agent.yml` (in that order). Warns when
 * more than one exists (so a YAML build isn't silently shadowed by a stray JSON).
 * None exist → `agent.json` (the historical default; the build's readFile then
 * yields the same ENOENT error). `exists` is injected so this is unit-testable.
 */
export function resolveBuildFile(
  dir: string,
  deps: { exists: (path: string) => boolean },
): ResolveBuildFileResult {
  const candidates = ["agent.json", "agent.yaml", "agent.yml"];
  const present = candidates.filter((c) => deps.exists(join(dir, c)));
  if (present.length === 0) return { file: join(dir, "agent.json") };
  const file = join(dir, present[0]);
  if (present.length > 1) {
    return {
      file,
      warning: `iris build: multiple Agentfiles present (${present.join(", ")}); building ${present[0]} — pass --file to choose`,
    };
  }
  return { file };
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
  // Optional tool transport wiring. Default = an empty invoker (no transport
  // configured), preserving the install-free / fake-model-calls-no-tools posture.
  // The CLI passes a subprocess invoker built from the project's bundled tools.
  toolInvoker?: ToolInvoker;
  // Names of tools allowed without an approval gate (the bundled retrySafe tools).
  safeTools?: string[];
  // Opt-in governance: a who-may-approve policy + the approval inbox the channel/UI
  // submits decisions to. Absent → ungoverned (existing behavior, byte-identical).
  governance?: { policy: ApprovalPolicy; inbox: ApprovalInbox };
  // Opt-in subagent delegation. Absent → no `subagent` effect (byte-identical).
  subagents?: CliSubagents;
  // Retain the full journal (no truncation after a snapshot) so the governance audit
  // trail (auditApprovals) stays COMPLETE across long sessions. Default undefined →
  // false → the engine truncates as before (existing behavior, byte-identical).
  keepHistory?: boolean;
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

  // Delegate tool names (if any) are gate-allowed (so a delegation doesn't park on
  // approval — matches demo.ts) AND routed as `subagent` effects via subagentTools.
  const subNames = opts.subagents?.names ?? [];
  const bundle = defaultBundle({ safeTools: [...(opts.safeTools ?? []), ...subNames] });
  // Reconstruct minimal contracts from the lock for dispatch (description/
  // inputSchema are model-perceived only — not needed to INVOKE). The tool
  // transport is INJECTED (default: an empty invoker, so a fake model that calls
  // no tools stays install-free); the CLI supplies a subprocess invoker.
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(
    makeToolRegistry(contracts),
    opts.toolInvoker ?? makeToolInvoker({}),
  );

  return runTurn(
    {
      store: opts.store,
      scheduler: opts.scheduler,
      clock: opts.clock,
      program: harnessProgram(
        opts.input ?? { messages: [{ role: "user", content: "hi" }] },
        subNames.length ? { subagentTools: subNames } : undefined,
      ),
      performers: {
        tactic: bundle.tacticPerformer,
        model_call: opts.modelPerformer,
        tool_call: toolPerformer,
        ...governancePerformers(opts.governance),
        ...subagentPerformers(opts.subagents, opts.sessionId),
      },
      defDigest,
      holderId: "iris-run",
      assertReplay: true,
      ...(opts.keepHistory !== undefined ? { keepHistory: opts.keepHistory } : {}),
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
  web?: boolean; // serve the @irisrun/channel-web chat UI at GET / (same port)
  channel?: string; // --channel: "rest" (default — makeRestChannel) or a module exporting openChannel
  toolInvoker?: ToolInvoker; // default: an empty invoker (no transport configured)
  safeTools?: string[]; // tools allowed without an approval gate (bundled retrySafe)
  // Opt-in governance (same shape as cmdRun): policy + inbox. Absent → ungoverned.
  governance?: { policy: ApprovalPolicy; inbox: ApprovalInbox };
  // Opt-in subagent delegation. Absent → no `subagent` effect (byte-identical).
  subagents?: CliSubagents;
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
  const subNames = opts.subagents?.names ?? []; // delegate tool names
  const bundle = defaultBundle({ safeTools: [...(opts.safeTools ?? []), ...subNames] });
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));
  const clock = opts.clock ?? { now: (): number => 0 };

  // Reconstruct tool contracts from the lock for dispatch (same as cmdRun). The
  // tool transport is INJECTED (default empty); the CLI supplies a subprocess invoker.
  const contracts: ToolContract[] = image.lock.tools.map((t) => ({
    name: t.name,
    description: "",
    inputSchema: {},
    transport: t.transport,
    location: t.location,
    retrySafe: t.retrySafe,
  }));
  const toolPerformer = makeToolPerformer(
    makeToolRegistry(contracts),
    opts.toolInvoker ?? makeToolInvoker({}),
  );

  // Forkless channel selection: "rest" (default → makeRestChannel) or a module exporting
  // openChannel. The options object below is the channel-rest RestChannelOptions, which is
  // exactly the @irisrun/sdk OpenChannelOptions a custom channel also receives.
  const makeChannel = await resolveChannel(opts.channel);
  const channel = await makeChannel<HarnessState>({
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
      // Governance: a continue-message body may carry an approval decision; submit it
      // to the shared inbox BEFORE the turn so the HITL resume reads it (zero channel
      // surgery — the decision rides the existing message body). No-op when ungoverned.
      if (opts.governance) submitApprovalFromBody(opts.governance.inbox, body, onWarn);
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
        program: harnessProgram(
          bodyToInput(body),
          subNames.length ? { subagentTools: subNames } : undefined,
        ),
        performers: {
          tactic: bundle.tacticPerformer,
          model_call: opts.makeModelPerformer(modelId, onDelta),
          tool_call: toolPerformer,
          ...governancePerformers(opts.governance),
          ...subagentPerformers(opts.subagents, sessionId),
        },
        clock,
        defDigest,
      };
    },
  });

  const url = await channel.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1");
  return { url, close: (): Promise<void> => channel.close() };
}

// --- iris bridge: serve a forkless platform bridge in front of a running channel -----
//
// `iris bridge <module> --base-url <channelUrl>` makes a chat platform reachable: it
// dynamic-imports the module's `openBridge` (resolveBridge), builds the verify→parse→drive
// →format harness with `makePlatformBridge`, and serves a node:http endpoint that pipes
// each request to `bridge.handle(headers, rawBody)`. The bridge speaks ONLY the REST wire
// to `--base-url` (where `iris serve` is listening) — no core change, the channel analog of
// `--store`. The platform code stays a reference example; only the loader is first-party.

export interface CliBridgeOptions {
  baseUrl: string; // where `iris serve` is listening (the Iris REST channel)
  port?: number; // default 8788
  host?: string; // default 127.0.0.1
  env?: Record<string, string | undefined>; // platform config source (default process.env)
  fetchImpl?: typeof fetch; // injectable for tests
}

// Read the raw request body + flatten headers, drive the bridge, write the reply. A STRING
// body (e.g. Twilio TwiML/XML) is written raw as application/xml; an object as JSON. The
// body-read idiom mirrors channel-rest's server (for await over the request stream).
// NOTE: the body is decoded as UTF-8 — all six reference platforms sign UTF-8 JSON/form
// bodies, so the adapter's HMAC over this string is byte-faithful. A platform that signed a
// non-UTF-8 body would need the raw bytes threaded through instead.
async function handleBridgeRequest(bridge: PlatformBridge<unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
  const r = await bridge.handle(headers, rawBody);
  if (typeof r.body === "string") {
    res.writeHead(r.status, { "content-type": "application/xml" });
    res.end(r.body);
  } else {
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  }
}

/** `iris bridge`: resolve the bridge module, build it over `--base-url`, and listen. */
export async function cmdBridge(moduleSpec: string, opts: CliBridgeOptions): Promise<ServeHandle> {
  const openBridge = await resolveBridge(moduleSpec);
  const adapter = await openBridge({ env: opts.env ?? process.env });
  const bridge = makePlatformBridge(adapter, { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  const server = createServer((req, res) => {
    handleBridgeRequest(bridge, req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  const port = opts.port ?? 8788;
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- 9e: deploy (multi-platform target registry) ------------------------------
//
// `iris deploy <layout> --target <name>` scaffolds a self-contained project for a
// chosen platform: read the image, run the capability-diff gate (assertDeployable)
// against the target's profile and refuse an over-capable image LOUDLY BEFORE
// writing anything, then write the target's generated files. Targets span three
// runtime families (edge / container / faas) defined in ./deploy-targets.ts;
// `--target` defaults to "cloudflare" (backward-compatible). The ONLY real-deploy
// egress is Cloudflare's `wrangler deploy`, ENV-GATED (operator-installed wrangler
// + a real account) — every other target is scaffold-only with a printed deploy
// hint, like push/pull's "real registry = manual", so the install-free /
// zero-runtime-dep invariant holds.

/** `iris deploy` supports BUILT-IN providers only — forkless `--provider`/`--channel`
 *  modules are run/serve/chat-only (the generated worker bakes a built-in provider, and
 *  the deploy path derives the provider from the image's model-id prefix). Throws loudly
 *  if either flag is present; `deployCommand` calls this BEFORE cmdDeploy so it pre-empts
 *  the prefix throw. Exported so the refusal is behaviorally testable. */
export function assertDeployFlagsSupported(flags: { provider?: string; channel?: string }): void {
  if (flags.provider !== undefined || flags.channel !== undefined) {
    throw new Error(
      "iris deploy: forkless --provider/--channel modules are not supported at deploy time — the generated worker bakes in a built-in provider. Use them with `iris serve`/`run`/`chat`.",
    );
  }
}

export interface CliDeployOptions {
  // The deploy target (registry key in ./deploy-targets.ts). Default "cloudflare"
  // (backward-compatible). The target supplies the capability profile the gate
  // checks against + the scaffold generator. (Replaces the old `host?` field — no
  // known caller injected a host; the gate now derives it from the target.)
  target?: string;
  outDir: string;
  name?: string; // service/worker name (default: the image's agent name, sanitized)
  compatibilityDate?: string; // Cloudflare compatibility_date (edge only; harmless elsewhere)
  writeFile?: (path: string, data: string) => Promise<void>; // injected; default fs
  mkdir?: (path: string) => Promise<void>;
  // env-gated real-deploy runner — Cloudflare/wrangler ONLY (refused for non-edge
  // targets); absent = scaffold-only (print the plan, don't deploy).
  deploy?: { run: (args: string[], cwd: string) => Promise<number> };
}

export interface DeployResult {
  outDir: string;
  files: string[];
  deployed: boolean;
  plan: string;
}

// `stripModelPrefix` + provider selection live in ./providers.ts; the per-target
// scaffold generators, capability profiles, and the gate's noop host live in
// ./deploy-targets.ts (imported above).

// service/worker names: lowercase alphanumerics + hyphens.
function sanitizeName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "iris-agent" : s;
}

export async function cmdDeploy(layoutdir: string, opts: CliDeployOptions): Promise<DeployResult> {
  // 1. Resolve the target (throws loudly on an unknown name — ZERO files).
  const target = getTarget(opts.target ?? "cloudflare");

  // 2. Real-deploy egress is Cloudflare/wrangler-only. Refuse a non-edge --deploy
  //    BEFORE reading the image or writing anything (ZERO files).
  if (opts.deploy && target.family !== "edge") {
    throw new Error(
      `iris deploy: --deploy (real egress) is only supported for --target cloudflare (wrangler). ` +
        `For ${target.label}, scaffold then run the printed deploy command manually.`,
    );
  }

  const image = await readOciLayout(layoutdir);

  // 3. GATE: refuse an over-capable image LOUDLY, BEFORE any write. The gate reads
  //    only host.name (= target.label) + host.capabilities (the target's ceiling).
  assertDeployable(image.lock.capabilities, noopHostFor(target));

  // 4. Build the scaffold context. The provider is selected from the image's
  //    `<provider>/` model-id prefix and stripped to the bare id the API wants
  //    (cf. wrapModelForImage).
  const ctx: ScaffoldContext = {
    name: sanitizeName(opts.name ?? image.agentfile.name ?? "iris-agent"),
    model: stripModelPrefix(image.lock.model.id),
    defDigest: image.lock.imageDigest,
    provider: providerDescriptor(providerNameForModel(image.lock.model.id)),
    compatDate: opts.compatibilityDate ?? DEFAULT_COMPAT_DATE,
    irisVersion: IRIS_VERSION,
  };

  // 5. Generate the files (pure) and write them, creating nested parent dirs
  //    (e.g. ".do/app.yaml") as needed.
  const writeFileImpl = opts.writeFile ?? ((p: string, d: string): Promise<void> => writeFile(p, d));
  const mkdirImpl =
    opts.mkdir ??
    (async (p: string): Promise<void> => {
      await mkdir(p, { recursive: true });
    });

  await mkdirImpl(opts.outDir);
  const scaffold = target.scaffold(ctx);
  for (const f of scaffold) {
    const full = join(opts.outDir, f.path);
    const parent = dirname(full);
    if (parent !== opts.outDir) await mkdirImpl(parent); // nested path (e.g. .do/app.yaml)
    await writeFileImpl(full, f.contents);
  }
  const files = scaffold.map((f) => f.path);

  // 6. Real deploy: Cloudflare/wrangler only (guaranteed edge by step 2).
  let deployed = false;
  if (opts.deploy) {
    const code = await opts.deploy.run(["deploy"], opts.outDir);
    if (code !== 0) throw new Error(`iris deploy: \`wrangler deploy\` exited with code ${code}`);
    deployed = true;
  }

  const plan = deployed
    ? `iris deploy: deployed '${ctx.name}' to ${target.label} (wrangler deploy)`
    : target.plan(ctx, opts.outDir);
  return { outDir: opts.outDir, files, deployed, plan };
}
