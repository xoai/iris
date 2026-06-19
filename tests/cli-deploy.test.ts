// Phase C (P0 item 3) — `iris deploy` (Cloudflare Durable Objects, supported path).
// cmdDeploy reads an image, runs the M6 capability-diff gate (assertDeployable), and
// scaffolds a Worker project (wrangler.toml + worker.mjs). A remote-only image
// scaffolds; an image demanding local_subprocess tools is REFUSED with the
// byte-identical ADR-0008 message and writes ZERO files (the gate runs before any
// write). The real `wrangler deploy` egress is an env-gated manual smoke, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdBuild, cmdDeploy } from "@iris/cli";
import { makeLocalResolver } from "@iris/agent";

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

async function buildImage(requires?: Record<string, unknown>) {
  const src = await tmp("iris-deploy-src-");
  await cmdInit(src);
  if (requires) {
    const agentPath = join(src, "agent.json");
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as Record<string, unknown>;
    agent.requires = requires;
    await writeFile(agentPath, JSON.stringify(agent, null, 2));
  }
  const out = await tmp("iris-deploy-oci-");
  const image = await cmdBuild({ file: join(src, "agent.json"), out, resolver: makeLocalResolver({}) });
  return { out, image };
}

test("A1: a remote-only image scaffolds a valid Cloudflare Worker project (no network)", async () => {
  const { out, image } = await buildImage(); // default scaffold: requires.tool_locality "remote"
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
  assert.match(worker, /import \{ edgeHost \} from "@iris\/store-do"/);
  assert.match(worker, /class AgentDO/);
  // embeds the PREFIX-STRIPPED model id (anthropic/claude-x → claude-x) so the
  // real-key anthropicModelPerformer({model}) path sends a valid model to the API.
  const id = image.lock.model.id; // e.g. "anthropic/claude-x"
  const stripped = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  assert.ok(worker.includes(`const MODEL = ${JSON.stringify(stripped)}`), "embeds the stripped model id");
  if (id.includes("/")) {
    assert.ok(!worker.includes(`const MODEL = ${JSON.stringify(id)}`), "the provider prefix was stripped");
  }
});

test("A1: an image demanding local_subprocess tools is REFUSED (ADR-0008) and writes ZERO files", async () => {
  const { out } = await buildImage({ local_subprocess: true, tool_locality: "local" });
  const fs = captureFs();
  const dest = await tmp("iris-deploy-out-");

  await assert.rejects(
    () => cmdDeploy(out, { outDir: dest, writeFile: fs.writeFile, mkdir: fs.mkdir }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      // byte-identical ADR-0008 refusal, interpolating the edge host name "Cloudflare"
      assert.match(e.message, /requires local_subprocess tools; the Cloudflare target supports remote MCP tools only/);
      return true;
    },
  );
  assert.equal(fs.writes.length, 0, "the gate threw BEFORE any file was written");
});
