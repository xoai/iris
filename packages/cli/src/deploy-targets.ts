// The `iris deploy` target registry. Generalizes deploy from one hard-coded
// Cloudflare scaffold to a registry of targets across three runtime families:
//   • edge      — a workerd isolate; remote-only, no held process (Cloudflare).
//   • container — a held `iris serve` Node process; full server capabilities
//                 (Render, GCP Cloud Run, Azure Container Apps, DO App Platform,
//                 generic Docker/VPS).
//   • faas      — a cold-per-turn function with an EXTERNAL durable store; same
//                 capability vector as edge (the generated handler wires only
//                 tactic + model_call — no local tool invoker) (AWS Lambda, GCP
//                 Cloud Functions, Azure Functions).
//
// Each target supplies (a) a capability profile for the deploy gate
// (`assertDeployable` reads only .name/.capabilities) and (b) a PURE scaffold
// generator returning the files to write — no fs, no network. The Cloudflare
// path is the byte-identical original (locked by tests/cli-deploy.test.ts); the
// worker.mjs/wrangler.toml generators are MOVED here verbatim.
import type { CapabilityProfile } from "@irisrun/agent";
import type { HostAdapter } from "@irisrun/host";
import type { StateStore, Scheduler } from "@irisrun/core";
import type { ProviderDescriptor } from "./providers.ts";

// Baked into generated Dockerfiles + FaaS package.json install/dep lines. A unit
// test (tests/cli-deploy-targets.test.ts) asserts this equals the cli package
// version so a stale value can never ship broken `npm install -g iris-runtime@X`.
export const IRIS_VERSION = "0.4.0";

export const DEFAULT_COMPAT_DATE = "2026-01-01";

// --- family capability profiles (the host ceiling the gate checks against) ----
//
// EDGE_CAPS is byte-identical to edgeHost's capabilities (store-do/src/host.ts),
// so the Cloudflare gate is unchanged. FAAS_CAPS equals EDGE_CAPS: the generated
// FaaS handler wires only tactic + model_call (no subprocess tool invoker) and
// holds no process across turns — a cold, remote-tools host. CONTAINER_CAPS is a
// full server (runs `iris serve` with a real subprocess tool invoker), so it
// accepts local-tool AND long-running images. This makes the gate a router:
// "your agent needs local tools → deploy to a container target, not the edge."
const EDGE_CAPS: CapabilityProfile = {
  long_running: false,
  filesystem: false,
  local_subprocess: false,
  websockets: false,
  tool_locality: "remote",
};
const CONTAINER_CAPS: CapabilityProfile = {
  long_running: true,
  filesystem: true,
  local_subprocess: true,
  websockets: true,
  tool_locality: "in-process",
};
const FAAS_CAPS: CapabilityProfile = {
  long_running: false,
  filesystem: false,
  local_subprocess: false,
  websockets: false,
  tool_locality: "remote",
};

// --- types -------------------------------------------------------------------

export type DeployFamily = "edge" | "container" | "faas";

/** Inputs every scaffold generator receives (pure data; no fs, no network). */
export interface ScaffoldContext {
  name: string; // sanitized agent/worker/service name
  model: string; // prefix-stripped model id (e.g. "claude-x")
  defDigest: string; // image.lock.imageDigest
  provider: ProviderDescriptor; // { name, envKey, pkg, bufferedExport, streamingExport }
  compatDate: string; // Cloudflare compatibility_date (edge only; harmless elsewhere)
  irisVersion: string; // pinned iris-runtime version baked into Dockerfiles/package.json
}

export interface ScaffoldFile {
  path: string; // RELATIVE to outDir (may contain subdirs, e.g. ".do/app.yaml")
  contents: string;
}

export interface DeployTarget {
  name: string; // registry key + --target value (e.g. "render")
  label: string; // human label for the gate refusal + plan (e.g. "Render")
  family: DeployFamily;
  description: string; // one line for --list-targets
  capabilities: CapabilityProfile; // the host ceiling the gate checks against
  scaffold(ctx: ScaffoldContext): ScaffoldFile[];
  /** Next-step instructions printed after a scaffold-only run. */
  plan(ctx: ScaffoldContext, outDir: string): string;
}

// --- the gate hack (no @irisrun/host change) ---------------------------------
//
// HostAdapter is exactly { name, capabilities, store, scheduler } (host/adapter.ts),
// and assertDeployable reads only .name/.capabilities — so a literal with throwing
// port stubs cast `as unknown as` FULLY satisfies the type and is tsc-clean.
export function noopHostFor(target: DeployTarget): HostAdapter {
  const fail = (): never => {
    throw new Error("iris deploy: host ports are not available at scaffold time");
  };
  const port = { get: fail, put: fail, delete: fail, list: fail, transaction: fail, setAlarm: fail, getAlarm: fail };
  return {
    name: target.label, // interpolated into the capability refusal message
    capabilities: target.capabilities,
    store: port as unknown as StateStore,
    scheduler: port as unknown as Scheduler,
  };
}

// --- cloudflare (edge) — MOVED verbatim from iris.ts (byte-identical output) --
// (ctx.name is already sanitized by cmdDeploy; sanitizeName stays in iris.ts.)

function wranglerToml(name: string, compatDate: string): string {
  return [
    `name = "${name}"`,
    `main = "worker.mjs"`,
    `compatibility_date = "${compatDate}"`,
    ``,
    `# The agent's durable state lives in this Durable Object (single-writer lease +`,
    `# transactional storage + alarms = sleepUntil). @irisrun/core + @irisrun/store-do are`,
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

function workerMjs(model: string, defDigest: string, desc: ProviderDescriptor): string {
  const M = JSON.stringify(model);
  const D = JSON.stringify(defDigest);
  const ENVKEY = desc.envKey; // e.g. ANTHROPIC_API_KEY | OPENAI_API_KEY
  const PKG = desc.pkg; // @irisrun/provider-anthropic | @irisrun/provider-openai
  const PERF = desc.bufferedExport; // anthropicModelPerformer | openaiModelPerformer
  return `// GENERATED by \`iris deploy\` — a Cloudflare Worker + Durable Object running the
// SAME @irisrun/core unchanged on workerd (generalizes tests/smoke/cloudflare-workers-smoke.ts).
// Bundled by wrangler/esbuild on deploy; core is node:-free so it targets the isolate.
import { edgeHost } from "@irisrun/store-do";
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { runTurnOn } from "@irisrun/host";

const MODEL = ${M};
const DEF_DIGEST = ${D};

// Adapt a real Cloudflare DurableObjectStorage to @irisrun/store-do's narrow DoStorage
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
  // A real model when ${ENVKEY} is set (the ${PKG} adapter is fetch-based; dynamic
  // import keeps it out of the no-key path), else an inline echo. The provider is
  // selected from the image's model-id prefix at \`iris deploy\` time.
  let model_call;
  if (env && env.${ENVKEY}) {
    const { ${PERF} } = await import("${PKG}");
    model_call = ${PERF}({ apiKey: env.${ENVKEY}, model: MODEL });
  } else {
    model_call = async () => ({ ok: true, value: { role: "assistant", content: "echo (set ${ENVKEY} for a real model)", stopReason: "end_turn" } });
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

const cloudflareTarget: DeployTarget = {
  name: "cloudflare",
  label: "Cloudflare", // HARD CONSTRAINT: byte-lock for the refusal message
  family: "edge",
  description: "Cloudflare Workers + Durable Objects (edge isolate; remote tools only)",
  capabilities: EDGE_CAPS,
  scaffold(ctx) {
    return [
      { path: "wrangler.toml", contents: wranglerToml(ctx.name, ctx.compatDate) },
      { path: "worker.mjs", contents: workerMjs(ctx.model, ctx.defDigest, ctx.provider) },
    ];
  },
  plan(ctx, outDir) {
    return (
      `iris deploy: scaffolded a ${this.label} Worker for '${ctx.name}' in ${outDir}.\n` +
      `  To deploy: cd ${outDir} && wrangler deploy  (needs a Cloudflare account + wrangler; set ${ctx.provider.envKey} as a secret for a real model)`
    );
  },
};

// --- container family — one shared Dockerfile + entrypoint, per-platform manifest

// The Dockerfile is identical across every container target: it runs the held
// `iris serve` process. It installs the runtime PLUS the optional store backends
// and their native drivers, so IRIS_STORE=sqlite|postgres|redis all resolve at
// runtime (sqlite ships inside iris-runtime; postgres/redis are separate packages
// whose drivers pg/redis are dynamic-imported by resolveStore). The operator
// places their built OCI image in the build context; `iris serve` reads it from
// /app/image and ignores the extra generated files.
function containerDockerfile(ctx: ScaffoldContext): string {
  return [
    "# GENERATED by `iris deploy` — runs `iris serve` in a container (held process).",
    "# @irisrun/core runs unchanged on Node 24; the durable store is selected by IRIS_STORE.",
    "FROM node:24-slim",
    "WORKDIR /app",
    "# Runtime + the optional store backends + their drivers, so IRIS_STORE=sqlite|postgres|redis",
    "# all work out of the box. (Real deploy needs these published to npm — scaffold-only caveat.)",
    `RUN npm install -g iris-runtime@${ctx.irisVersion} @irisrun/store-postgres@${ctx.irisVersion} @irisrun/store-redis@${ctx.irisVersion} pg redis`,
    "# Place your built OCI image alongside this Dockerfile (iris serve reads /app/image).",
    "COPY . /app/image",
    "ENV PORT=8787 IRIS_STORE=sqlite IRIS_DB=/data/iris.db",
    "VOLUME /data",
    "EXPOSE 8787",
    "COPY iris-entrypoint.sh /app/iris-entrypoint.sh",
    "RUN chmod +x /app/iris-entrypoint.sh",
    'CMD ["/app/iris-entrypoint.sh"]',
    "",
  ].join("\n");
}

// Maps the friendly IRIS_STORE name to the real `iris serve --store` arg + a
// sensible default --db per store, then execs the server. sqlite is the default.
const IRIS_ENTRYPOINT_SH = [
  "#!/bin/sh",
  "set -e",
  '# Map the friendly IRIS_STORE name to the real `iris serve --store` module + a default --db.',
  'case "${IRIS_STORE:-sqlite}" in',
  '  sqlite)   STORE=sqlite;                  DB="${IRIS_DB:-/data/iris.db}" ;;',
  '  postgres) STORE=@irisrun/store-postgres; DB="${IRIS_DB:-$DATABASE_URL}" ;;',
  '  redis)    STORE=@irisrun/store-redis;    DB="${IRIS_DB:-$REDIS_URL}" ;;',
  '  *)        STORE="${IRIS_STORE}";          DB="${IRIS_DB:-/data/iris.db}" ;;',
  "esac",
  'exec iris serve /app/image --host 0.0.0.0 --port "${PORT:-8787}" --store "$STORE" --db "$DB" --web',
  "",
].join("\n");

function containerPlan(label: string, ctx: ScaffoldContext, outDir: string, hint: string): string {
  return (
    `iris deploy: scaffolded a ${label} project for '${ctx.name}' in ${outDir}.\n` +
    `  Copy your built image into ${outDir} (or run with --out <imagedir>), then deploy:\n` +
    `    ${hint}\n` +
    `  Set ${ctx.provider.envKey} for a real model. IRIS_STORE defaults to sqlite (postgres/redis also available).`
  );
}

// Per-platform manifest generators (the ONLY difference between container targets).
function renderYaml(ctx: ScaffoldContext): string {
  return [
    "# Render Blueprint — https://render.com/docs/blueprint-spec",
    "services:",
    "  - type: web",
    `    name: ${ctx.name}`,
    "    runtime: docker",
    "    dockerfilePath: ./Dockerfile",
    "    envVars:",
    "      - key: IRIS_STORE",
    "        value: sqlite",
    `      - key: ${ctx.provider.envKey}`,
    "        sync: false",
    "    disk:",
    "      name: iris-data",
    "      mountPath: /data",
    "      sizeGB: 1",
    "",
  ].join("\n");
}

function cloudRunYaml(ctx: ScaffoldContext): string {
  return [
    "# GCP Cloud Run service — deploy with: gcloud run deploy --source .",
    "# NOTE: Cloud Run's filesystem is ephemeral; for durable state across instances set",
    "# IRIS_STORE=postgres + DATABASE_URL (sqlite on /data persists only within an instance).",
    "apiVersion: serving.knative.dev/v1",
    "kind: Service",
    "metadata:",
    `  name: ${ctx.name}`,
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    `        - image: gcr.io/PROJECT_ID/${ctx.name}`,
    "          ports:",
    "            - containerPort: 8787",
    "          env:",
    "            - name: IRIS_STORE",
    "              value: sqlite",
    `            - name: ${ctx.provider.envKey}`,
    '              value: ""',
    "",
  ].join("\n");
}

function azureContainerAppYaml(ctx: ScaffoldContext): string {
  return [
    "# Azure Container Apps — deploy with: az containerapp up --source .",
    "properties:",
    "  configuration:",
    "    ingress:",
    "      external: true",
    "      targetPort: 8787",
    "  template:",
    "    containers:",
    `      - name: ${ctx.name}`,
    `        image: ${ctx.name}:latest`,
    "        env:",
    "          - name: IRIS_STORE",
    "            value: sqlite",
    `          - name: ${ctx.provider.envKey}`,
    '            value: ""',
    "",
  ].join("\n");
}

function doAppYaml(ctx: ScaffoldContext): string {
  return [
    "# DigitalOcean App Platform — deploy with: doctl apps create --spec .do/app.yaml",
    `name: ${ctx.name}`,
    "services:",
    `  - name: ${ctx.name}`,
    "    dockerfile_path: Dockerfile",
    "    http_port: 8787",
    "    envs:",
    "      - key: IRIS_STORE",
    "        value: sqlite",
    `      - key: ${ctx.provider.envKey}`,
    "        scope: RUN_TIME",
    "        type: SECRET",
    "",
  ].join("\n");
}

function dockerComposeYml(ctx: ScaffoldContext): string {
  return [
    "# Generic Docker / VPS — run with: docker compose up --build",
    "services:",
    `  ${ctx.name}:`,
    "    build: .",
    '    ports:',
    '      - "8787:8787"',
    "    environment:",
    "      IRIS_STORE: sqlite",
    "      IRIS_DB: /data/iris.db",
    `      # ${ctx.provider.envKey}: set your model API key for a real model`,
    "    volumes:",
    "      - iris-data:/data",
    "volumes:",
    "  iris-data:",
    "",
  ].join("\n");
}

/** Build a container-family target sharing the Dockerfile + entrypoint, differing
 *  only in its platform manifest + deploy hint. */
function containerTarget(spec: {
  name: string;
  label: string;
  description: string;
  manifestPath: string;
  manifest: (ctx: ScaffoldContext) => string;
  hint: string;
}): DeployTarget {
  return {
    name: spec.name,
    label: spec.label,
    family: "container",
    description: spec.description,
    capabilities: CONTAINER_CAPS,
    scaffold(ctx) {
      return [
        { path: "Dockerfile", contents: containerDockerfile(ctx) },
        { path: "iris-entrypoint.sh", contents: IRIS_ENTRYPOINT_SH },
        { path: spec.manifestPath, contents: spec.manifest(ctx) },
      ];
    },
    plan(ctx, outDir) {
      return containerPlan(spec.label, ctx, outDir, spec.hint);
    },
  };
}

const containerTargets: DeployTarget[] = [
  containerTarget({
    name: "render",
    label: "Render",
    description: "Render.com web service (Docker container; persistent disk)",
    manifestPath: "render.yaml",
    manifest: renderYaml,
    hint: "commit render.yaml + push to a Render-connected repo (or use the Render dashboard)",
  }),
  containerTarget({
    name: "gcp-cloud-run",
    label: "GCP Cloud Run",
    description: "Google Cloud Run (container; scale-to-zero)",
    manifestPath: "service.yaml",
    manifest: cloudRunYaml,
    hint: "gcloud run deploy --source .",
  }),
  containerTarget({
    name: "azure-container-apps",
    label: "Azure Container Apps",
    description: "Azure Container Apps (container; managed Kubernetes)",
    manifestPath: "containerapp.yaml",
    manifest: azureContainerAppYaml,
    hint: "az containerapp up --source .",
  }),
  containerTarget({
    name: "digitalocean-app",
    label: "DigitalOcean App Platform",
    description: "DigitalOcean App Platform (container web service)",
    manifestPath: ".do/app.yaml",
    manifest: doAppYaml,
    hint: "doctl apps create --spec .do/app.yaml",
  }),
  containerTarget({
    name: "docker",
    label: "Docker / VPS",
    description: "Generic Docker / VPS (docker-compose; bring your own host)",
    manifestPath: "docker-compose.yml",
    manifest: dockerComposeYml,
    hint: "docker compose up --build",
  }),
];

// --- FaaS family — shared turn-runner body + per-platform wrapper -------------
//
// Mirrors the Cloudflare worker (same defaultBundle / harnessProgram / runTurnOn),
// but builds the store from env via the store module's openStore (a cold function
// holds no process across turns, so durable state MUST be external). The handler
// wires only tactic + model_call — no local tool invoker — which is exactly why
// FAAS_CAPS == EDGE_CAPS (remote tools only).
function faasHandlerBody(ctx: ScaffoldContext, label: string): string {
  const M = JSON.stringify(ctx.model);
  const D = JSON.stringify(ctx.defDigest);
  const ENVKEY = ctx.provider.envKey;
  const PKG = ctx.provider.pkg;
  const PERF = ctx.provider.bufferedExport;
  // The host's writer identity (holderId) — the platform label, mirroring
  // edgeHost's default "Cloudflare" name in the generated worker.
  const LABEL = JSON.stringify(label);
  return `// GENERATED by \`iris deploy\` — a FaaS handler running the SAME @irisrun/core on a
// cold-per-turn function. Durable state lives in an EXTERNAL store (this scaffold
// bundles Postgres); the model provider is baked from the image's model-id prefix.
import { harnessProgram, defaultBundle } from "@irisrun/core";
import { runTurnOn } from "@irisrun/host";

const MODEL = ${M};
const DEF_DIGEST = ${D};
// The capability vector this handler honors (cold, remote tools — no local subprocess).
const CAPS = { long_running: false, filesystem: false, local_subprocess: false, websockets: false, tool_locality: "remote" };

async function openStoreFromEnv(env) {
  // This scaffold bundles ONLY @irisrun/store-postgres (+ the pg driver) in package.json.
  // To use a different store, add its package AND its driver to package.json and set IRIS_STORE.
  const spec = env.IRIS_STORE && env.IRIS_STORE !== "sqlite" ? env.IRIS_STORE : "@irisrun/store-postgres";
  const url = env.IRIS_DB || env.DATABASE_URL;
  if (!url) throw new Error("iris FaaS: needs an external store (this scaffold bundles Postgres) — set DATABASE_URL (or IRIS_DB). A function's local disk does not survive cold starts. To use another store, add its package + driver to package.json and set IRIS_STORE.");
  const mod = await import(spec);
  return mod.openStore({ url });
}

async function runOneTurn(env, sessionId, input) {
  const { store, scheduler, close } = await openStoreFromEnv(env);
  try {
    const bundle = defaultBundle({ safeTools: [] });
    const program = harnessProgram(input, { invariants: bundle.invariants });
    // A real model when ${ENVKEY} is set (the ${PKG} adapter is fetch-based; dynamic
    // import keeps it out of the no-key path), else an inline echo.
    let model_call;
    if (env.${ENVKEY}) {
      const { ${PERF} } = await import("${PKG}");
      model_call = ${PERF}({ apiKey: env.${ENVKEY}, model: MODEL });
    } else {
      model_call = async () => ({ ok: true, value: { role: "assistant", content: "echo (set ${ENVKEY} for a real model)", stopReason: "end_turn" } });
    }
    const host = { name: ${LABEL}, capabilities: CAPS, store, scheduler };
    return await runTurnOn(host, { sessionId, defDigest: DEF_DIGEST, program, performers: { tactic: bundle.tacticPerformer, model_call }, clock: { now: () => Date.now() }, assertReplay: true });
  } finally {
    if (close) await close();
  }
}
`;
}

// Per-platform handler wrappers (appended to the shared body). Each reads the
// request body's {messages} (default a "hi" turn) + a ?session query param.
const AWS_LAMBDA_WRAPPER = `
// AWS Lambda (Function URL / API Gateway proxy event).
export const handler = async (event) => {
  const q = event && event.queryStringParameters;
  const sessionId = (q && q.session) || "default";
  let input = { messages: [{ role: "user", content: "hi" }] };
  if (event && event.body) {
    try { const b = JSON.parse(event.body); if (b && Array.isArray(b.messages) && b.messages.length) input = { messages: b.messages }; } catch {}
  }
  const out = await runOneTurn(process.env, sessionId, input);
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
};
`;

const GCP_FUNCTIONS_WRAPPER = `
// GCP Cloud Functions (functions-framework HTTP signature).
export const iris = async (req, res) => {
  const sessionId = (req.query && req.query.session) || "default";
  let input = { messages: [{ role: "user", content: "hi" }] };
  const b = req.body;
  if (b && Array.isArray(b.messages) && b.messages.length) input = { messages: b.messages };
  const out = await runOneTurn(process.env, sessionId, input);
  res.json(out);
};
`;

const AZURE_FUNCTIONS_WRAPPER = `
// Azure Functions (httpTrigger).
export default async function (context, req) {
  const sessionId = (req.query && req.query.session) || "default";
  let input = { messages: [{ role: "user", content: "hi" }] };
  const b = req.body;
  if (b && Array.isArray(b.messages) && b.messages.length) input = { messages: b.messages };
  const out = await runOneTurn(process.env, sessionId, input);
  context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
}
`;

function faasPackageJson(ctx: ScaffoldContext, extra?: Record<string, string>): string {
  const v = `^${ctx.irisVersion}`;
  const dependencies: Record<string, string> = {
    "@irisrun/core": v,
    "@irisrun/host": v,
    "@irisrun/store-postgres": v,
    pg: "^8", // REQUIRED — store-postgres declares pg as an optional peer
    [ctx.provider.pkg]: v,
    ...(extra ?? {}),
  };
  return JSON.stringify({ name: ctx.name, private: true, type: "module", main: "index.mjs", dependencies }, null, 2) + "\n";
}

function samTemplate(ctx: ScaffoldContext): string {
  return [
    "# AWS SAM — sam build && sam deploy --guided",
    "AWSTemplateFormatVersion: '2010-09-09'",
    "Transform: AWS::Serverless-2016-10-31",
    "Resources:",
    "  IrisAgent:",
    "    Type: AWS::Serverless::Function",
    "    Properties:",
    "      Handler: index.handler",
    "      Runtime: nodejs22.x",
    "      MemorySize: 512",
    "      Timeout: 60",
    "      FunctionUrlConfig:",
    "        AuthType: NONE",
    "      Environment:",
    "        Variables:",
    '          IRIS_STORE: "@irisrun/store-postgres"',
    '          DATABASE_URL: ""',
    `          ${ctx.provider.envKey}: ""`,
    "",
  ].join("\n");
}

const AZURE_FUNCTION_JSON =
  JSON.stringify(
    {
      bindings: [
        { authLevel: "anonymous", type: "httpTrigger", direction: "in", name: "req", methods: ["get", "post"] },
        { type: "http", direction: "out", name: "res" },
      ],
    },
    null,
    2,
  ) + "\n";

const AZURE_HOST_JSON = JSON.stringify({ version: "2.0" }, null, 2) + "\n";

function faasPlan(label: string, ctx: ScaffoldContext, outDir: string, hint: string): string {
  return (
    `iris deploy: scaffolded a ${label} function for '${ctx.name}' in ${outDir}.\n` +
    `  Install deps + deploy:\n` +
    `    npm install   # then:\n` +
    `    ${hint}\n` +
    `  This handler needs an EXTERNAL store (bundles Postgres): set DATABASE_URL. Set ${ctx.provider.envKey} for a real model.`
  );
}

/** Build a FaaS-family target: the shared handler body + a platform wrapper +
 *  the platform's extra files (manifest, package.json). */
function faasTarget(spec: {
  name: string;
  label: string;
  description: string;
  wrapper: string;
  extraFiles: (ctx: ScaffoldContext) => ScaffoldFile[];
  hint: string;
}): DeployTarget {
  return {
    name: spec.name,
    label: spec.label,
    family: "faas",
    description: spec.description,
    capabilities: FAAS_CAPS,
    scaffold(ctx) {
      return [
        { path: "index.mjs", contents: faasHandlerBody(ctx, spec.label) + spec.wrapper },
        ...spec.extraFiles(ctx),
      ];
    },
    plan(ctx, outDir) {
      return faasPlan(spec.label, ctx, outDir, spec.hint);
    },
  };
}

const faasTargets: DeployTarget[] = [
  faasTarget({
    name: "aws-lambda",
    label: "AWS Lambda",
    description: "AWS Lambda function (SAM; external store via DATABASE_URL)",
    wrapper: AWS_LAMBDA_WRAPPER,
    extraFiles: (ctx) => [
      { path: "template.yaml", contents: samTemplate(ctx) },
      { path: "package.json", contents: faasPackageJson(ctx) },
    ],
    hint: "sam build && sam deploy --guided",
  }),
  faasTarget({
    name: "gcp-cloud-functions",
    label: "GCP Cloud Functions",
    description: "Google Cloud Functions (functions-framework; external store)",
    wrapper: GCP_FUNCTIONS_WRAPPER,
    extraFiles: (ctx) => [
      { path: "package.json", contents: faasPackageJson(ctx, { "@google-cloud/functions-framework": "^3" }) },
    ],
    hint: "gcloud functions deploy iris --gen2 --runtime nodejs22 --trigger-http --entry-point iris",
  }),
  faasTarget({
    name: "azure-functions",
    label: "Azure Functions",
    description: "Azure Functions (httpTrigger; external store)",
    wrapper: AZURE_FUNCTIONS_WRAPPER,
    extraFiles: (ctx) => [
      { path: "function.json", contents: AZURE_FUNCTION_JSON },
      { path: "host.json", contents: AZURE_HOST_JSON },
      { path: "package.json", contents: faasPackageJson(ctx) },
    ],
    hint: "func azure functionapp publish <app-name>",
  }),
];

// --- the registry ------------------------------------------------------------

const TARGETS: DeployTarget[] = [cloudflareTarget, ...containerTargets, ...faasTargets];

export const DEPLOY_TARGETS: Record<string, DeployTarget> = Object.fromEntries(
  TARGETS.map((t) => [t.name, t]),
);

/** Targets in stable registration order (for --list-targets). */
export function listTargets(): DeployTarget[] {
  return TARGETS.slice();
}

/** Resolve a --target name; throws LOUDLY (listing valid names) on an unknown one. */
export function getTarget(name: string): DeployTarget {
  const t = DEPLOY_TARGETS[name];
  if (!t) {
    const valid = TARGETS.map((x) => x.name).join(", ");
    throw new Error(
      `iris deploy: unknown --target "${name}". Valid targets: ${valid}. Run \`iris deploy --list-targets\` for details.`,
    );
  }
  return t;
}
