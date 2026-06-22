// `iris deploy --target <name>` — the multi-platform deploy-target registry.
// The existing `tests/cli-deploy.test.ts` locks the DEFAULT (Cloudflare) path
// byte-for-byte; THIS suite covers the registry + the new container/FaaS targets
// + the capability-routing matrix. All generators are pure string functions, so
// every assertion is install-free, deterministic, and zero-network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cmdInit, cmdBuild, cmdDeploy, loadBundledTools, getTarget, listTargets, IRIS_VERSION } from "iris-runtime";

const ALL_TARGETS = [
  "cloudflare",
  "render",
  "gcp-cloud-run",
  "azure-container-apps",
  "digitalocean-app",
  "docker",
  "aws-lambda",
  "gcp-cloud-functions",
  "azure-functions",
];
const CONTAINER_NAMES = ["render", "gcp-cloud-run", "azure-container-apps", "digitalocean-app", "docker"];
const REMOTE_ONLY_NAMES = ["cloudflare", "aws-lambda", "gcp-cloud-functions", "azure-functions"]; // edge + faas

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

// A capturing fs: records every (path, data) write and mkdir, makes nothing real.
function captureFs() {
  const writes: { path: string; data: string }[] = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    writeFile: async (path: string, data: string): Promise<void> => {
      writes.push({ path, data });
    },
    mkdir: async (path: string): Promise<void> => {
      mkdirs.push(path);
    },
    // find a written file by suffix
    find(suffix: string): string | undefined {
      return writes.find((w) => w.path.endsWith(suffix))?.data;
    },
    names(): string[] {
      // last path segment(s) relative to the out dir — the registry returns
      // relative paths joined onto outDir, so strip the tmp out dir prefix.
      return writes.map((w) => w.path);
    },
  };
}

// Build an image from the scaffold, optionally overriding `requires`/`tools`/`model`.
async function buildImage(overrides?: {
  requires?: Record<string, unknown>;
  tools?: unknown[];
  model?: string;
}) {
  const src = await tmp("iris-dt-src-");
  await cmdInit(src, { json: true });
  if (overrides) {
    const agentPath = join(src, "agent.json");
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as Record<string, unknown>;
    if (overrides.requires) agent.requires = overrides.requires;
    if (overrides.tools !== undefined) agent.tools = overrides.tools;
    if (overrides.model !== undefined) agent.model = overrides.model;
    await writeFile(agentPath, JSON.stringify(agent, null, 2));
  }
  const out = await tmp("iris-dt-oci-");
  const resolver = (await loadBundledTools(join(src, "tools"))).resolver;
  await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  return out;
}

// A remote, tool-less image — deployable on EVERY target (edge/faas/container).
const remoteImage = (model?: string) =>
  buildImage({ requires: { tool_locality: "remote" }, tools: [], ...(model ? { model } : {}) });

// Deploy helper: capture the emitted files (relative names) + plan.
async function deploy(out: string, target: string) {
  const fs = captureFs();
  const dest = await tmp("iris-dt-dst-");
  const result = await cmdDeploy(out, { target, outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir });
  // relative file names the registry chose (result.files is the source of truth)
  return { fs, result, dest };
}

// ---------------------------------------------------------------------------
// M1 — registry + Cloudflare refactor (behavior-preserving)
// ---------------------------------------------------------------------------

test("M1: the registry contains the cloudflare edge target with label exactly 'Cloudflare'", () => {
  const cf = getTarget("cloudflare");
  assert.equal(cf.name, "cloudflare");
  assert.equal(cf.label, "Cloudflare", "byte-lock: the refusal message interpolates this label");
  assert.equal(cf.family, "edge");
  assert.ok(listTargets().some((t) => t.name === "cloudflare"));
});

test("M1: getTarget on an unknown name throws loudly listing valid targets", () => {
  assert.throws(
    () => getTarget("nope"),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /unknown --target "nope"/);
      assert.match(e.message, /cloudflare/);
      return true;
    },
  );
});

test("M1: IRIS_VERSION matches packages/cli/package.json version (no-drift guard)", async () => {
  const pkgPath = fileURLToPath(new URL("../packages/cli/package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
  assert.equal(IRIS_VERSION, pkg.version, "the baked IRIS_VERSION constant drifted from the cli package version");
});

test("M1: default target (no --target) is cloudflare and emits the byte-identical worker project", async () => {
  const out = await remoteImage();
  const { fs, result } = await deploy(out, undefined as unknown as string); // no target → cloudflare
  assert.deepEqual(result.files, ["wrangler.toml", "worker.mjs"]);
  assert.equal(result.deployed, false);
  const wrangler = fs.find("wrangler.toml")!;
  const worker = fs.find("worker.mjs")!;
  assert.match(wrangler, /class_name = "AgentDO"/);
  assert.match(worker, /import \{ edgeHost \} from "@irisrun\/store-do"/);
  assert.match(worker, /class AgentDO/);
});

test("M1: an over-capable (local-subprocess) image is REFUSED on cloudflare with the byte-identical message, ZERO files", async () => {
  const out = await buildImage(); // DEFAULT scaffold ships a local subprocess tool
  const fs = captureFs();
  const dest = await tmp("iris-dt-dst-");
  await assert.rejects(
    () => cmdDeploy(out, { target: "cloudflare", outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /requires local_subprocess tools; the Cloudflare target supports remote MCP tools only/);
      return true;
    },
  );
  assert.equal(fs.writes.length, 0, "the gate threw BEFORE any write");
});

// ---------------------------------------------------------------------------
// M2 — container family (5 targets, one shared Dockerfile + entrypoint)
// ---------------------------------------------------------------------------

const CONTAINER_TARGETS: Record<string, string> = {
  render: "render.yaml",
  "gcp-cloud-run": "service.yaml",
  "azure-container-apps": "containerapp.yaml",
  "digitalocean-app": ".do/app.yaml",
  docker: "docker-compose.yml",
};

test("M2: render emits Dockerfile + entrypoint + render.yaml with the right wiring", async () => {
  const out = await remoteImage();
  const { result, fs } = await deploy(out, "render");
  assert.deepEqual(result.files, ["Dockerfile", "iris-entrypoint.sh", "render.yaml"]);

  const dockerfile = fs.find("Dockerfile")!;
  assert.match(dockerfile, /FROM node:24-slim/);
  // pins iris-runtime + the store backends + their native drivers (so IRIS_STORE=postgres|redis work)
  assert.match(dockerfile, /npm install -g iris-runtime@0\.3\.0 @irisrun\/store-postgres@0\.3\.0 @irisrun\/store-redis@0\.3\.0 pg redis/);
  assert.match(dockerfile, /EXPOSE 8787/);
  assert.match(dockerfile, /iris-entrypoint\.sh/);

  const entry = fs.find("iris-entrypoint.sh")!;
  assert.match(entry, /case "\$\{IRIS_STORE:-sqlite\}"/);
  assert.match(entry, /STORE=@irisrun\/store-postgres/);
  assert.match(entry, /STORE=@irisrun\/store-redis/);
  assert.match(entry, /iris serve \/app\/image --host 0\.0\.0\.0 --port/);
  assert.match(entry, /--store "\$STORE"/);
  assert.match(entry, /--web/);

  const render = fs.find("render.yaml")!;
  assert.match(render, /type: web/);
  assert.match(render, /runtime: docker/);
  assert.match(render, /ANTHROPIC_API_KEY/); // default scaffold model is anthropic/
});

test("M2: every container target emits the shared Dockerfile+entrypoint and its own manifest", async () => {
  for (const [name, manifest] of Object.entries(CONTAINER_TARGETS)) {
    const out = await remoteImage();
    const { result, fs } = await deploy(out, name);
    assert.ok(result.files.includes("Dockerfile"), `${name}: Dockerfile`);
    assert.ok(result.files.includes("iris-entrypoint.sh"), `${name}: entrypoint`);
    assert.ok(result.files.includes(manifest), `${name}: expected manifest ${manifest}, got ${result.files.join(",")}`);
    assert.ok(fs.find(manifest.split("/").pop()!), `${name}: manifest content written`);
    assert.match(result.plan, new RegExp(name === "docker" ? "docker compose" : name.split("-")[0], "i"));
  }
});

test("M2: a container target ACCEPTS the default local-subprocess image (capability routing)", async () => {
  const out = await buildImage(); // DEFAULT scaffold: local subprocess tool — refused on edge
  const { result } = await deploy(out, "render"); // ...but accepted on a container
  assert.ok(result.files.includes("Dockerfile"));
  assert.equal(result.deployed, false);
});

test("M2: provider variance — an openai image lists OPENAI_API_KEY, never ANTHROPIC_API_KEY", async () => {
  const out = await remoteImage("openai/gpt-x");
  const { fs } = await deploy(out, "render");
  const render = fs.find("render.yaml")!;
  assert.match(render, /OPENAI_API_KEY/);
  assert.doesNotMatch(render, /ANTHROPIC_API_KEY/);
});

// ---------------------------------------------------------------------------
// M3 — FaaS family (3 targets, shared handler body + per-platform wrapper)
// ---------------------------------------------------------------------------

const FAAS_FILES: Record<string, string[]> = {
  "aws-lambda": ["index.mjs", "template.yaml", "package.json"],
  "gcp-cloud-functions": ["index.mjs", "package.json"],
  "azure-functions": ["index.mjs", "function.json", "host.json", "package.json"],
};

test("M3: aws-lambda emits handler + SAM template + package.json with the right wiring", async () => {
  const out = await remoteImage();
  const { result, fs } = await deploy(out, "aws-lambda");
  assert.deepEqual(result.files, ["index.mjs", "template.yaml", "package.json"]);

  const handler = fs.find("index.mjs")!;
  assert.match(handler, /export const handler = async/);
  assert.match(handler, /import \{ runTurnOn \} from "@irisrun\/host"/);
  assert.match(handler, /openStoreFromEnv/);
  assert.match(handler, /\.openStore\(\{ url \}\)/);
  // bakes the prefix-stripped model id + the correct provider import/key (anthropic default)
  assert.match(handler, /const MODEL = "claude-x"/);
  assert.match(handler, /await import\("@irisrun\/provider-anthropic"\)/);
  assert.match(handler, /env\.ANTHROPIC_API_KEY/);

  const tmpl = fs.find("template.yaml")!;
  assert.match(tmpl, /AWS::Serverless::Function/);
  assert.match(tmpl, /index\.handler/);

  const pkg = JSON.parse(fs.find("package.json")!) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies["@irisrun/host"], "needs @irisrun/host");
  assert.equal(pkg.dependencies["@irisrun/store-postgres"], "^0.3.0");
  assert.equal(pkg.dependencies["pg"], "^8", "pg is the required postgres driver");
  assert.equal(pkg.dependencies["@irisrun/provider-anthropic"], "^0.3.0");
});

test("M3: every FaaS target emits its expected files and bakes the model id", async () => {
  for (const [name, files] of Object.entries(FAAS_FILES)) {
    const out = await remoteImage();
    const { result, fs } = await deploy(out, name);
    assert.deepEqual(result.files, files, `${name}: file set`);
    const handler = fs.find("index.mjs")!;
    assert.match(handler, /const MODEL = "claude-x"/, `${name}: bakes model id`);
    assert.match(handler, /runTurnOn/, `${name}: runs a turn`);
  }
});

test("M3: the FaaS no-store error mentions Postgres (matches the postgres-only package.json)", async () => {
  const out = await remoteImage();
  const { fs } = await deploy(out, "aws-lambda");
  const handler = fs.find("index.mjs")!;
  assert.match(handler, /bundles Postgres/i);
  assert.match(handler, /DATABASE_URL/);
});

test("M3: provider variance — an openai FaaS image imports provider-openai, never anthropic", async () => {
  const out = await remoteImage("openai/gpt-x");
  const { fs } = await deploy(out, "gcp-cloud-functions");
  const handler = fs.find("index.mjs")!;
  assert.match(handler, /await import\("@irisrun\/provider-openai"\)/);
  assert.match(handler, /const MODEL = "gpt-x"/);
  assert.doesNotMatch(handler, /provider-anthropic/);
  const pkg = JSON.parse(fs.find("package.json")!) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies["@irisrun/provider-openai"]);
  assert.ok(!pkg.dependencies["@irisrun/provider-anthropic"]);
});

// ---------------------------------------------------------------------------
// M4 — CLI wiring + capability-routing matrix
// ---------------------------------------------------------------------------

async function assertRefused(out: string, target: string) {
  const fs = captureFs();
  const dest = await tmp("iris-dt-dst-");
  await assert.rejects(
    () => cmdDeploy(out, { target, outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir }),
    `${target}: expected the gate to refuse this image`,
  );
  assert.equal(fs.writes.length, 0, `${target}: the gate threw BEFORE any write`);
}

async function assertAccepted(out: string, target: string) {
  const { result } = await deploy(out, target);
  assert.ok(result.files.length > 0, `${target}: expected a scaffold`);
  assert.equal(result.deployed, false);
}

test("M4 matrix: a local-subprocess image — refused on edge+faas, accepted on every container", async () => {
  for (const t of REMOTE_ONLY_NAMES) await assertRefused(await buildImage(), t); // DEFAULT scaffold = local tool
  for (const t of CONTAINER_NAMES) await assertAccepted(await buildImage(), t);
});

test("M4 matrix: a long_running image — refused on edge+faas, accepted on every container", async () => {
  const mk = () => buildImage({ requires: { long_running: true }, tools: [] });
  for (const t of REMOTE_ONLY_NAMES) await assertRefused(await mk(), t);
  for (const t of CONTAINER_NAMES) await assertAccepted(await mk(), t);
});

test("M4 matrix: a remote, tool-less image — accepted on ALL 9 targets", async () => {
  for (const t of ALL_TARGETS) await assertAccepted(await remoteImage(), t);
});

test("M4: --deploy on a non-edge target is refused (ZERO files, runner never called)", async () => {
  const out = await remoteImage();
  const fs = captureFs();
  const dest = await tmp("iris-dt-dst-");
  let called = false;
  await assert.rejects(
    () =>
      cmdDeploy(out, {
        target: "render",
        outDir: dest,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
        deploy: {
          run: async (): Promise<number> => {
            called = true;
            return 0;
          },
        },
      }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /only supported for --target cloudflare/);
      return true;
    },
  );
  assert.equal(called, false, "the deploy runner was never called");
  assert.equal(fs.writes.length, 0, "ZERO files written (refusal precedes writes)");
});

test("M4: the registry exposes exactly the 9 expected targets across 3 families", () => {
  assert.deepEqual(
    listTargets().map((t) => t.name).slice().sort(),
    [...ALL_TARGETS].sort(),
  );
  assert.deepEqual([...new Set(listTargets().map((t) => t.family))].sort(), ["container", "edge", "faas"]);
});

// CLI argv dispatch (spawn the real deployCommand path).
const cliMain = fileURLToPath(new URL("../packages/cli/src/cli-main.ts", import.meta.url));
const runCli = (args: string[]) =>
  spawnSync(process.execPath, [cliMain, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--conditions=iris-src" },
  });

test("M4 (cli): `iris deploy --list-targets` prints all 9 targets and exits 0", () => {
  const res = runCli(["deploy", "--list-targets"]);
  assert.equal(res.status, 0, res.stderr);
  for (const n of ALL_TARGETS) assert.match(res.stdout, new RegExp(n.replace(/[-]/g, "\\-")));
});

test("M4 (cli): `iris deploy --target render` with no layout is a usage error (leading-`--` guard)", () => {
  const res = runCli(["deploy", "--target", "render"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /usage: iris deploy/);
});
