// The interactive chat client — `iris chat`. A zero-dependency terminal REPL that
// lets a user converse turn-by-turn with a DURABLE Iris agent session ("like eve
// dev"), built on the harness kernel's gated interactive mode (ADR-0007): each
// user message is delivered via a `user_recv` performer, the session parks on a
// `{kind:"user"}` wait between messages, and the whole conversation is the
// session journal — so it survives process exit and resumes byte-identically.
//
// Host-side: only `node:` builtins + workspace packages. The pure pieces
// (`wrapModelForImage`, `makeChatFakeModel`, `renderOutcome`, `chatTurn`,
// `runChat`) take injected deps so they unit-test without a TTY, a key, or a real
// model; `cli-main.ts` wires the real fs/host/stdin defaults.
import { runTurn, harnessProgram } from "@iris/core";
import type {
  Performer,
  PerformerRegistry,
  Outcome,
  Json,
  StateStore,
  Scheduler,
  LogicalClock,
  HarnessState,
  TurnOutcome,
} from "@iris/core";
import { normalizeContentKey } from "@iris/agent";
import type { AgentImage } from "@iris/agent";

// --- model-call wrapper ------------------------------------------------------

/**
 * Adapt a raw model performer to an image: the kernel emits `model_call` with only
 * `{ messages }` (no `model`/`system`), so inject the image's model id (the
 * `provider/` prefix stripped for the API) and the embedded instructions as the
 * system prompt.
 *
 * Finding B: a provider error must NOT reach the kernel as `ok:false` — the engine
 * journals the failed result before the kernel throws, which poisons the session
 * on every subsequent replay. So a failure is converted into a synthetic `ok:true`
 * assistant message: the turn parks, the error shows as the agent's reply, and the
 * session stays healthy/resumable.
 */
// Default reply budget for the real model path. The kernel never sets maxTokens,
// and the provider would otherwise fall back to 1024 — too small for a chat reply.
// A caller-supplied maxTokens (if the kernel ever sets one) is preserved.
const CHAT_MAX_TOKENS = 4096;

export function wrapModelForImage(base: Performer, image: AgentImage): Performer {
  const id = image.agentfile.model;
  const modelId = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const sysKey = normalizeContentKey(image.agentfile.instructions);
  const b64 = image.content[sysKey];
  const system = b64 !== undefined ? Buffer.from(b64, "base64").toString("utf8") : undefined;

  return async (request: Json, idempotencyKey?: string): Promise<Outcome> => {
    const req =
      request !== null && typeof request === "object" && !Array.isArray(request)
        ? (request as { [k: string]: Json })
        : {};
    const merged: Json = {
      ...req,
      model: modelId,
      ...(system !== undefined ? { system } : {}),
      ...(req.maxTokens === undefined ? { maxTokens: CHAT_MAX_TOKENS } : {}),
    };
    const out = await base(merged, idempotencyKey);
    if (out.ok) return out;
    return {
      ok: true,
      value: {
        role: "assistant",
        content: `⚠️ model error: ${out.error.message}`,
        stopReason: "error",
      } as unknown as Json,
    };
  };
}

/**
 * Deterministic install-free model — echoes the last user message. The keyless
 * default (mirrors the test fake, but ships in production so `iris chat` runs with
 * no `ANTHROPIC_API_KEY`). Not imported from tests/.
 */
export function makeChatFakeModel(): Performer {
  return async (request: Json): Promise<Outcome> => {
    const req = request as { messages?: Array<{ role: string; content: string }> };
    const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === "user");
    return {
      ok: true,
      value: { role: "assistant", content: `echo:${lastUser?.content ?? ""}`, stopReason: "end_turn" },
    };
  };
}

// --- rendering ---------------------------------------------------------------

/** What `runChat` prints for a turn outcome, and whether the loop should stop.
 *  PURE — every TurnOutcome variant is testable from a hand-built literal. The
 *  `contended` variant carries NO `state` (engine TurnOutcome), so this MUST NOT
 *  read `outcome.state` on that branch. */
export function renderOutcome(
  outcome: TurnOutcome<HarnessState>,
): { text: string; shouldBreak: boolean } {
  const replyText = (state: HarnessState): string => {
    const mo = state.modelOut as { content?: Json } | null;
    return mo !== null && typeof mo === "object" && typeof mo.content === "string" ? mo.content : "";
  };
  switch (outcome.status) {
    case "parked": {
      const wait = outcome.wait;
      if (wait.kind === "user") {
        return { text: `agent> ${replyText(outcome.state)}\n`, shouldBreak: false };
      }
      // a timer/signal park is not a chat turn boundary — surface it, keep going.
      const detail = wait.kind === "timer" ? `timer@${wait.at}` : `signal:${wait.name}`;
      return { text: `… agent parked (${detail}); not resumable from chat yet\n`, shouldBreak: false };
    }
    case "finished":
      return { text: `agent> ${replyText(outcome.state)}\n(session complete)\n`, shouldBreak: true };
    case "contended":
      return {
        text: `iris chat: another runner holds this session (current fence ${outcome.current}); exiting\n`,
        shouldBreak: true,
      };
    case "aborted":
      return { text: `iris chat: turn aborted (${outcome.reason}); exiting\n`, shouldBreak: true };
  }
}

// --- REPL --------------------------------------------------------------------

export interface ChatDeps {
  store: StateStore;
  scheduler: Scheduler;
  clock: LogicalClock;
  defDigest: string;
  modelPerformer: Performer; // wrapped (model+system injected) or the fake
  tacticPerformer: Performer; // defaultBundle().tacticPerformer
  toolPerformer?: Performer; // lock-derived; absent for the no-tool fake path
  sessionId: string;
  input: AsyncIterable<string>; // a source of LINES (prod: a readline interface)
  output: { write(s: string): void };
  isInteractive?: boolean; // write the `you>` prompt (TTY)
  banner?: string; // printed once at start
}

/** Run ONE user message as a turn against the durable session. The message is
 *  delivered via a per-turn `user_recv` performer (journaled → deterministic). */
export async function chatTurn(deps: ChatDeps, message: string): Promise<TurnOutcome<HarnessState>> {
  const performers: PerformerRegistry = {
    tactic: deps.tacticPerformer,
    model_call: deps.modelPerformer,
    user_recv: async () => ({ ok: true, value: { content: message } }),
  };
  if (deps.toolPerformer) performers.tool_call = deps.toolPerformer;
  return runTurn<HarnessState>(
    {
      store: deps.store,
      scheduler: deps.scheduler,
      clock: deps.clock,
      program: harnessProgram({ messages: [] }, { interactive: true }),
      performers,
      defDigest: deps.defDigest,
      holderId: "iris-chat",
      assertReplay: true,
    },
    deps.sessionId,
  );
}

/** The chat REPL: read lines, drive a turn per message, render the reply, until
 *  `/exit`, `/quit`, or end-of-input. Pure of process-global side effects (SIGINT
 *  lives in the cli-main entry) so it is unit-testable with an injected line
 *  source + output sink. */
export async function runChat(deps: ChatDeps): Promise<void> {
  if (deps.banner) deps.output.write(deps.banner);
  const prompt = (): void => {
    if (deps.isInteractive) deps.output.write("you> ");
  };
  const hint = "(session is durable — resume later with the same --session and --db)\n";
  prompt();
  for await (const raw of deps.input) {
    const line = raw.trim();
    if (line === "") {
      prompt();
      continue;
    }
    if (line === "/exit" || line === "/quit") {
      deps.output.write(hint);
      return;
    }
    let outcome: TurnOutcome<HarnessState>;
    try {
      outcome = await chatTurn(deps, line);
    } catch (e) {
      // Isolate a single failing turn — a tactic/tool throw must not kill the
      // whole REPL. The journal stays sound (model failures are absorbed by the
      // wrapper before they reach the kernel); surface it loudly and re-prompt.
      const msg = e instanceof Error ? e.message : String(e);
      deps.output.write(`iris chat: turn failed (${msg}); session preserved — try again\n`);
      prompt();
      continue;
    }
    const { text, shouldBreak } = renderOutcome(outcome);
    deps.output.write(text);
    if (shouldBreak) return; // finished / contended / aborted — a terminal outcome
    prompt();
  }
  // input ended (EOF / Ctrl-D) without an explicit /exit — the session stays put.
  deps.output.write(hint);
}
