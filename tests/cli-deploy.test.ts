// `iris deploy` (Cloudflare Durable Objects, supported path).
// cmdDeploy reads an image, runs the capability-diff gate (assertDeployable), and
// scaffolds a Worker project (wrangler.toml + worker.mjs). A remote-only image
// scaffolds; an image demanding local_subprocess tools is REFUSED with the
// byte-identical message and writes ZERO files (the gate runs before any
// write). The real `wrangler deploy` egress is an env-gated manual smoke, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdBuild, cmdDeploy, loadBundledTools } from "iris-runtime";

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
  };
}

// Build an image from the scaffold, optionally overriding `requires` and/or
// `tools`. The default scaffold now ships a LOCAL subprocess tool (so the edge
// gate refuses it — see the second test); the deploy-success test overrides to a
// remote, tool-less image. The resolver is derived from the scaffold's tools/ dir
// so the bundled `subprocess://now` ref resolves when present.
async function buildImage(overrides?: {
  requires?: Record<string, unknown>;
  tools?: unknown[];
  model?: string;
}) {
  const src = await tmp("iris-deploy-src-");
  await cmdInit(src, { json: true });
  if (overrides) {
    const agentPath = join(src, "agent.json");
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as Record<string, unknown>;
    if (overrides.requires) agent.requires = overrides.requires;
    if (overrides.tools !== undefined) agent.tools = overrides.tools;
    if (overrides.model !== undefined) agent.model = overrides.model;
    await writeFile(agentPath, JSON.stringify(agent, null, 2));
  }
  const out = await tmp("iris-deploy-oci-");
  const resolver = (await loadBundledTools(join(src, "tools"))).resolver;
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  return { out, image };
}

test("A1: a remote-only image scaffolds a valid Cloudflare Worker project (no network)", async () => {
  // the default scaffold is LOCAL (subprocess tool); a deployable image is remote + tool-less
  const { out, image } = await buildImage({ requires: { tool_locality: "remote" }, tools: [] });
  const fs = captureFs();
  const dest = await tmp("iris-deploy-out-");
  const result = await cmdDeploy(out, {
    outDir: dest,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
  });

  // emitted exactly the two project files, scaffold-only (no opts.deploy)
  assert.deepEqual(result.files, ["wrangler.toml", "worker.mjs"]);
  assert.equal(result.deployed, false);
  assert.ok(result.plan.length > 0, "a non-empty next-step plan");
  assert.match(result.plan, /wrangler deploy/);

  const wrangler = fs.writes.find((w) => w.path.endsWith("wrangler.toml"))!.data;
  const worker = fs.writes.find((w) => w.path.endsWith("worker.mjs"))!.data;
  assert.match(wrangler, /class_name = "AgentDO"/);
  assert.match(wrangler, /new_classes = \["AgentDO"\]/);
  // core+store-do are edge-native → no compat-flag directive (the word may appear in a comment)
  assert.doesNotMatch(wrangler, /compatibility_flags/);
  assert.doesNotMatch(wrangler, /node_compat\s*=/);
  assert.match(worker, /import \{ edgeHost \} from "@irisrun\/store-do"/);
  assert.match(worker, /class AgentDO/);
  // the default scaffold model is anthropic/claude-x → the worker wires the
  // Anthropic provider + ANTHROPIC_API_KEY (locks the generalized branch).
  assert.match(worker, /await import\("@irisrun\/provider-anthropic"\)/);
  assert.match(worker, /env\.ANTHROPIC_API_KEY/);
  assert.match(worker, /anthropicModelPerformer\(\{ apiKey: env\.ANTHROPIC_API_KEY, model: MODEL \}\)/);
  assert.doesNotMatch(worker, /provider-openai/, "an anthropic image must not import the openai provider");
  // embeds the PREFIX-STRIPPED model id (anthropic/claude-x → claude-x) so the
  // real-key anthropicModelPerformer({model}) path sends a valid model to the API.
  const id = image.lock.model.id; // e.g. "anthropic/claude-x"
  const stripped = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  assert.ok(worker.includes(`const MODEL = ${JSON.stringify(stripped)}`), "embeds the stripped model id");
  if (id.includes("/")) {
    assert.ok(!worker.includes(`const MODEL = ${JSON.stringify(id)}`), "the provider prefix was stripped");
  }
});

test("A1: an OpenAI-pinned image generates a worker wired to @irisrun/provider-openai", async () => {
  // a remote, tool-less image pinned to an openai/ model
  const { out } = await buildImage({
    requires: { tool_locality: "remote" },
    tools: [],
    model: "openai/gpt-x",
  });
  const fs = captureFs();
  const dest = await tmp("iris-deploy-out-");
  const result = await cmdDeploy(out, { outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir });

  assert.deepEqual(result.files, ["wrangler.toml", "worker.mjs"]);
  const worker = fs.writes.find((w) => w.path.endsWith("worker.mjs"))!.data;
  // the OpenAI branch: import the openai provider, read OPENAI_API_KEY, bake MODEL
  assert.match(worker, /await import\("@irisrun\/provider-openai"\)/);
  assert.match(worker, /env\.OPENAI_API_KEY/);
  assert.match(worker, /openaiModelPerformer\(\{ apiKey: env\.OPENAI_API_KEY, model: MODEL \}\)/);
  assert.ok(worker.includes(`const MODEL = ${JSON.stringify("gpt-x")}`), "embeds the stripped openai model id");
  // and NEVER the anthropic provider / key for an openai image
  assert.doesNotMatch(worker, /provider-anthropic/);
  assert.doesNotMatch(worker, /ANTHROPIC_API_KEY/);
});

test("A1: an image demanding local_subprocess tools is REFUSED and writes ZERO files", async () => {
  const { out } = await buildImage(); // the DEFAULT scaffold ships a local subprocess tool
  const fs = captureFs();
  const dest = await tmp("iris-deploy-out-");

  await assert.rejects(
    () => cmdDeploy(out, { outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      // byte-identical refusal, interpolating the edge host name "Cloudflare"
      assert.match(e.message, /requires local_subprocess tools; the Cloudflare target supports remote MCP tools only/);
      return true;
    },
  );
  assert.equal(fs.writes.length, 0, "the gate threw BEFORE any file was written");
});
