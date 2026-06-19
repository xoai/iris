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
import type { AgentImage, ImageInspection, RegistryResolver } from "@iris/agent";

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
