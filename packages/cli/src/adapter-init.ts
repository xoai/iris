// `iris adapter init <store|channel|provider> <name> [dir]` — scaffold a buildable,
// correctly-wired adapter package (one @irisrun/sdk dependency) so authoring a store,
// channel, or provider starts from a working skeleton instead of a blank file. Models
// cmdInit (inline template strings + fs writes). NO-CLOBBER: unlike cmdInit, it refuses an
// existing non-empty target — an adapter scaffold must never overwrite an author's work.
//
// The STORE scaffold ships a minimal CORRECT in-memory store, so its conformance suite
// passes green immediately (replace the Maps with your backend). The CHANNEL and PROVIDER
// scaffolds ship the port shape + the conformance wiring with marked TODOs — a green
// out-of-the-box stub there would mean embedding a full transport/vendor implementation.
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ADAPTER_KINDS = ["store", "channel", "provider"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export async function cmdAdapterInit(
  kind: string,
  name: string,
  dir = ".",
): Promise<{ dir: string; files: string[] }> {
  if (!ADAPTER_KINDS.includes(kind as AdapterKind)) {
    throw new Error(
      `iris adapter init: unknown kind "${kind}" — use one of: ${ADAPTER_KINDS.join(" | ")}`,
    );
  }
  if (!name) throw new Error("iris adapter init: a package <name> is required");
  const k = kind as AdapterKind;
  const target = join(dir, name);
  if (existsSync(target)) {
    const entries = await readdir(target).catch(() => [] as string[]);
    if (entries.length > 0) {
      throw new Error(
        `iris adapter init: "${target}" already exists and is not empty — refusing to overwrite (no-clobber)`,
      );
    }
  }
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "test"), { recursive: true });
  const files: Record<string, string> = {
    "package.json": PACKAGE_JSON(name),
    "tsconfig.json": TSCONFIG,
    "README.md": README(name, k),
    "src/index.ts": SRC[k](name),
    [`test/${name}.test.ts`]: TEST[k](name),
  };
  for (const [rel, content] of Object.entries(files)) await writeFile(join(target, rel), content);
  return { dir: target, files: Object.keys(files) };
}

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      type: "module",
      description: `An Iris adapter (${name}).`,
      exports: { ".": { "iris-src": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" } },
      scripts: {
        test: "node --test 'test/**/*.test.ts'",
        build: "tsc -p tsconfig.json",
      },
      dependencies: { "@irisrun/sdk": "^0.2.0" },
      devDependencies: { "@types/node": "^25.9.3", typescript: "^6.0.3" },
      engines: { node: ">=24" },
      files: ["dist"],
    },
    null,
    2,
  )}\n`;

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      declaration: true,
      rootDir: "src",
      outDir: "dist",
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
)}\n`;

const README = (name: string, kind: AdapterKind): string =>
  `# ${name}\n\nAn Iris **${kind}** adapter, scaffolded by \`iris adapter init\`. It depends on one\npackage — [\`@irisrun/sdk\`](https://www.npmjs.com/package/@irisrun/sdk) — which re-exports the\nport types, the conformance suite, and the forkless-loader contract.\n\n## Develop\n\n\`\`\`sh\nnpm install\nnpm test     # runs the @irisrun/${kind === "store" ? "store" : kind === "channel" ? "channel" : "provider"}-conformance suite\nnpm run build\n\`\`\`\n\n${KIND_README[kind]}\n\nSee the contributor recipe: docs/contributing/adding-a-${kind}.md.\n`;

const KIND_README: Record<AdapterKind, string> = {
  store:
    "`src/index.ts` ships a **minimal, correct in-memory store** — the conformance suite is\n**green** as-is. Replace the in-memory `Map`s with your backend (Postgres, Redis, S3, a KV\nnamespace…), keeping the one invariant: `append`'s fence-check + seq-check + insert are a\nsingle ATOMIC operation. Run it: `iris run ./image --store <this-package> --db <url>`.",
  channel:
    "`src/index.ts` is a TODO skeleton — `openChannel` returns a `{ listen, close }` handle whose\n`listen` THROWS until you stand up your transport. Drive `makeChannelSession`, map your wire to the\n`ChannelPort`, and supply `runTurn` (via `runTurnOn` from `@irisrun/host`), then certify it with a\n`ChannelPortFixture` against `@irisrun/channel-conformance` (see the TODOs in `test/`).",
  provider:
    "`src/index.ts` is a working **buffered** `model_call` performer over a placeholder JSON\nAPI — adapt the request shaping + response canonicalization to your vendor, implement the\n**streaming** twin, then fill the fixture TODOs in `test/` to pass\n`@irisrun/provider-conformance`. Run it: `iris serve ./image --provider <this-package>`.",
};

// ---------------------------------------------------------------------------
const SRC: Record<AdapterKind, (name: string) => string> = {
  store: () => `import type {
  StateStore,
  Scheduler,
  Version,
  CasResult,
  AppendResult,
  JournalRow,
  WakeupSource,
  OpenStore,
} from "@irisrun/sdk";

// A minimal, CORRECT in-memory store — your starting point. It passes the conformance
// suite as-is (\`npm test\`). Replace the Maps with your real backend, keeping the ONE
// invariant: append's fence-check + seq-check + insert are a single ATOMIC operation.
export class MyStateStore implements StateStore {
  private kv = new Map<string, { bytes: Uint8Array; version: Version }>();
  private journals = new Map<string, JournalRow[]>();
  private snapshots = new Map<string, { upToSeq: number; bytes: Uint8Array }>();
  private hwm = new Map<string, number>();
  private fences = new Map<string, Version>();

  async load(key: string): Promise<{ bytes: Uint8Array; version: Version } | null> {
    const cur = this.kv.get(key);
    return cur ? { bytes: cur.bytes, version: cur.version } : null;
  }
  async cas(key: string, expected: Version | null, next: Uint8Array): Promise<CasResult> {
    const cur = this.kv.get(key);
    const curVer = cur ? cur.version : null;
    if (curVer !== expected) return { ok: false, current: curVer ?? 0 };
    const version = (curVer ?? 0) + 1;
    this.kv.set(key, { bytes: next, version });
    return { ok: true, version };
  }
  async append(
    sessionId: string,
    expectedSeq: number,
    records: Uint8Array[],
    fence: Version,
  ): Promise<AppendResult> {
    const storedFence = this.fences.get(sessionId) ?? 0;
    if (fence < storedFence) return { ok: false, reason: "stale_fence", currentFence: storedFence };
    const last = this.hwm.get(sessionId) ?? -1;
    if (last !== expectedSeq - 1) return { ok: false, reason: "seq_conflict", currentSeq: last };
    const j = this.journals.get(sessionId) ?? [];
    let seq = last;
    for (const bytes of records) {
      seq += 1;
      j.push({ seq, bytes });
    }
    this.journals.set(sessionId, j);
    this.hwm.set(sessionId, seq);
    this.fences.set(sessionId, Math.max(storedFence, fence));
    return { ok: true, seq };
  }
  async readJournal(sessionId: string, fromSeq: number): Promise<JournalRow[]> {
    return (this.journals.get(sessionId) ?? []).filter((r) => r.seq >= fromSeq);
  }
  async writeSnapshot(sessionId: string, upToSeq: number, bytes: Uint8Array): Promise<void> {
    this.snapshots.set(sessionId, { upToSeq, bytes });
    // Seed the high-water mark so a migrated tail (starting at upToSeq+1) appends densely.
    this.hwm.set(sessionId, Math.max(this.hwm.get(sessionId) ?? -1, upToSeq));
  }
  async readLatestSnapshot(sessionId: string): Promise<{ upToSeq: number; bytes: Uint8Array } | null> {
    return this.snapshots.get(sessionId) ?? null;
  }
  async truncateJournal(sessionId: string, throughSeq: number): Promise<void> {
    const j = this.journals.get(sessionId) ?? [];
    this.journals.set(sessionId, j.filter((r) => r.seq > throughSeq));
  }
}

export class MyScheduler implements Scheduler, WakeupSource {
  private timers = new Map<string, number>();
  private signals = new Map<string, string[]>();
  async sleepUntil(sessionId: string, wakeAt: number): Promise<void> {
    this.timers.set(sessionId, wakeAt);
  }
  async waitForSignal(_sessionId: string, _name: string): Promise<void> {
    // The wait is recorded in the journal; delivery is via the host wake path.
  }
  async signal(sessionId: string, name: string): Promise<void> {
    const s = this.signals.get(sessionId) ?? [];
    s.push(name);
    this.signals.set(sessionId, s);
  }
  dueWakeups(now: number): { sessionId: string; kind: "timer" | "signal"; name?: string }[] {
    const out: { sessionId: string; kind: "timer" | "signal"; name?: string }[] = [];
    for (const [sessionId, at] of this.timers) if (at <= now) out.push({ sessionId, kind: "timer" });
    for (const [sessionId, names] of this.signals)
      for (const name of names) out.push({ sessionId, kind: "signal", name });
    return out;
  }
  confirmWoken(sessionId: string, now: number): void {
    const at = this.timers.get(sessionId);
    if (at !== undefined && at <= now) this.timers.delete(sessionId);
    this.signals.delete(sessionId);
  }
}

// The forkless loader entry: \`iris run --store <this-module> --db <url>\`.
export const openStore: OpenStore = (_opts) => ({
  store: new MyStateStore(),
  scheduler: new MyScheduler(),
});
`,

  channel: () => `import type { OpenChannel } from "@irisrun/sdk";

// A channel is a wire in front of a durable session. The two-identifier protocol (mint a
// sessionId, own/rotate a single-use continuationToken, refuse loudly) is NOT yours to
// write — drive \`makeChannelSession\` (from @irisrun/sdk) for it. You supply the transport
// (HTTP, WebSocket, a platform SDK) + \`runTurn\` (via \`runTurnOn\` from @irisrun/host) and
// return a { listen, close } handle. See docs/contributing/adding-a-channel.md, then
// certify with @irisrun/channel-conformance (test/).
export const openChannel: OpenChannel = (_opts) => ({
  listen: async (_port?: number, _host?: string): Promise<string> => {
    throw new Error("TODO: stand up your transport and drive makeChannelSession (see README)");
  },
  close: async (): Promise<void> => {},
});
`,

  provider: (name: string) => `import type {
  OpenProvider,
  Performer,
  Json,
  ModelCallRequest,
  ModelCallResult,
  ModelPerformerOptions,
  StreamingModelPerformerOptions,
} from "@irisrun/sdk";

// TODO: shape the request for YOUR vendor's API and CANONICALIZE the reply into the
// 4-field ModelCallResult so the journal replays byte-identically. This buffered performer
// is complete over a placeholder JSON API; the streaming twin is a TODO. Then fill the
// fixture in test/${name}.test.ts to pass @irisrun/provider-conformance.
function myModelPerformer(opts: ModelPerformerOptions = {}): Performer {
  const apiKey = opts.apiKey ?? process.env.MY_API_KEY;
  const doFetch = opts.fetchImpl ?? fetch;
  // Resolve config — and fail LOUDLY — at construction, never mid-turn.
  if (!apiKey && !opts.fetchImpl) throw new Error("myModelPerformer: set MY_API_KEY (or inject fetchImpl)");
  return async (request: Json) => {
    const req = request as unknown as ModelCallRequest;
    const model = req.model ?? opts.model;
    if (!model) return { ok: false, error: { message: "no model id (request.model and opts.model both absent)" } };
    const res = await doFetch(opts.baseUrl ?? "https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: \`Bearer \${apiKey}\` },
      body: JSON.stringify({ model, messages: req.messages, max_tokens: req.maxTokens ?? 1024 }),
    });
    if (!res.ok) return { ok: false, error: { message: \`HTTP \${res.status}\`, code: String(res.status) } };
    const body = (await res.json()) as { text?: string; stop?: string; in?: number; out?: number };
    const result: ModelCallResult = {
      role: "assistant",
      content: body.text ?? "",
      stopReason: body.stop ?? "stop",
      ...(body.in !== undefined ? { usage: { inputTokens: body.in, outputTokens: body.out ?? 0 } } : {}),
    };
    return { ok: true, value: result as unknown as Json };
  };
}

// TODO: a streaming twin with the SAME canonicalization (content === join(deltas)). For
// now it falls back to the buffered performer so the package builds.
function myStreamingModelPerformer(opts: StreamingModelPerformerOptions = {}): Performer {
  return myModelPerformer(opts);
}

// The forkless loader entry: \`iris serve --provider <this-module>\`.
export const openModelProvider: OpenProvider = () => ({
  buffered: (o) => myModelPerformer(o),
  streaming: (o) => myStreamingModelPerformer(o),
});
`,
};

// ---------------------------------------------------------------------------
const TEST: Record<AdapterKind, (name: string) => string> = {
  store: () => `import { test } from "node:test";
import { runStoreConformance, runSchedulerConformance, register } from "@irisrun/sdk";
import { MyStateStore, MyScheduler } from "../src/index.ts";

// The full store + scheduler port contract. Green as scaffolded; keep it green as you
// swap in your backend. Run with { concurrency } once your backend is real:
register(runStoreConformance(() => new MyStateStore()), test);
register(runSchedulerConformance(() => new MyScheduler()), test);
`,

  channel: () => `import { test } from "node:test";
import assert from "node:assert/strict";
import { openChannel } from "../src/index.ts";

// Smoke: the factory is the @irisrun/sdk OpenChannel contract. To certify a CUSTOM
// transport, build a ChannelPortFixture (stand up the channel, drive it with a client,
// force contend/abort) and \`register(runChannelPortConformance(fixture), test)\` — see
// @irisrun/channel-conformance and docs/contributing/adding-a-channel.md.
test("openChannel is a channel factory", () => {
  assert.equal(typeof openChannel, "function");
});
`,

  provider: (name: string) => `import { test } from "node:test";
import { runModelProviderConformance, register } from "@irisrun/sdk";
import type { ConformanceFixture } from "@irisrun/sdk";
import { openModelProvider } from "../src/index.ts";

// TODO: fill in your vendor's wire bodies + request-shape assertions, then this suite
// certifies your provider. The streaming bodies are empty placeholders — implement the
// streaming performer and these frames to go fully green.
const { buffered, streaming } = openModelProvider();
const fixture: ConformanceFixture = {
  name: "${name}",
  envKey: "MY_API_KEY",
  makeBuffered: (o) => buffered(o),
  makeStreaming: (o) => streaming(o),
  bufferedResponseBody: () => ({ text: "Hi there", stop: "stop", in: 5, out: 2 }),
  streamingSseBody: () => "", // TODO: your SSE frames ("Hi", " there", stop, usage)
  fallbackResponseBody: () => ({ text: "Hello", in: 3, out: 4 }),
  malformedSseBody: () => "", // TODO
  expected: { content: "Hi there", stopReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } },
  expectedFallback: { content: "Hello", usage: { inputTokens: 3, outputTokens: 4 } },
  assertRequestShape: () => {}, // TODO: assert your URL, auth header, body fields
  modelFromBody: (b) => b.model,
};

register(runModelProviderConformance(fixture), test);
`,
};
