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
import { stripModelPrefix } from "./providers.ts";

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
  // Strip the `provider/` prefix via the single source shared with the selection
  // seam (providers.ts) — keep this in lockstep with how the performer is chosen.
  const modelId = stripModelPrefix(image.agentfile.model);
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

/**
 * STREAMING variant of the keyless fake: same `echo:<content>` reply as
 * `makeChatFakeModel`, but emitted in word chunks via `onDelta` so the no-key
 * `iris chat` path demonstrates live token streaming. `onDelta` is optional
 * (mirrors `echoStreamingPerformer`); absent → deltas are dropped and only the
 * buffered result is returned. The returned `content` always equals the
 * concatenation of the deltas (reconcile invariant). Pure: no env/network.
 */
export function makeChatStreamingFakeModel(onDelta?: (text: string) => void): Performer {
  return async (request: Json): Promise<Outcome> => {
    const req = request as { messages?: Array<{ role?: string; content?: string }> };
    const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === "user");
    const reply = `echo:${lastUser?.content ?? ""}`;
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i++) onDelta?.(i === 0 ? words[i] : ` ${words[i]}`);
    return {
      ok: true,
      value: { role: "assistant", content: reply, stopReason: "end_turn" },
    };
  };
}

// --- rendering ---------------------------------------------------------------

/** What `runChat` prints for a turn outcome, and whether the loop should stop.
 *  PURE — every TurnOutcome variant is testable from a hand-built literal. The
 *  `contended` variant carries NO `state` (engine TurnOutcome), so this MUST NOT
 *  read `outcome.state` on that branch.
 *
 *  `opts.streamed` is set by `runChat` to `streamSink.wroteAny()` — i.e. the
 *  reply text was ALREADY written live to the output by the delta sink. In that
 *  case we must NOT print the reply again (no double-print): we emit only the
 *  closing newline + session markers. The buffered (non-streamed) path is
 *  unchanged. `contended`/`aborted` never run the model, so they ignore
 *  `streamed` and never read `state`. */
export function renderOutcome(
  outcome: TurnOutcome<HarnessState>,
  opts: { streamed?: boolean } = {},
): { text: string; shouldBreak: boolean } {
  const streamed = opts.streamed === true;
  const modelOut = (state: HarnessState): { content: string; stopReason?: string } => {
    const mo = state.modelOut as { content?: Json; stopReason?: Json } | null;
    const content =
      mo !== null && typeof mo === "object" && typeof mo.content === "string" ? mo.content : "";
    const stopReason =
      mo !== null && typeof mo === "object" && typeof mo.stopReason === "string"
        ? mo.stopReason
        : undefined;
    return { content, stopReason };
  };
  switch (outcome.status) {
    case "parked": {
      const wait = outcome.wait;
      if (wait.kind === "user") {
        if (streamed) {
          // Reply already streamed live → just close the line. The only way we
          // reach the error branch with `streamed` true is a MID-stream failure:
          // the streaming performer fired some deltas, then the stream threw, so
          // wrapModelForImage absorbed the ok:false into a synthetic error reply
          // (Finding B). The streamed tokens are partial, so surface the error
          // text on its own line — never hide a failure behind partial output.
          // (A PRE-stream failure fires no delta → wroteAny() is false → streamed
          // is false → the buffered branch below shows the error instead.)
          const { content, stopReason } = modelOut(outcome.state);
          const tail = stopReason === "error" ? `${content}\n` : "";
          return { text: `\n${tail}`, shouldBreak: false };
        }
        return { text: `agent> ${modelOut(outcome.state).content}\n`, shouldBreak: false };
      }
      // a timer/signal park is not a chat turn boundary — surface it, keep going.
      // A leading newline closes the streamed line first when streaming.
      const detail = wait.kind === "timer" ? `timer@${wait.at}` : `signal:${wait.name}`;
      const lead = streamed ? "\n" : "";
      return {
        text: `${lead}… agent parked (${detail}); not resumable from chat yet\n`,
        shouldBreak: false,
      };
    }
    case "finished":
      if (streamed) return { text: `\n(session complete)\n`, shouldBreak: true };
      return {
        text: `agent> ${modelOut(outcome.state).content}\n(session complete)\n`,
        shouldBreak: true,
      };
    case "contended":
      return {
        text: `iris chat: another runner holds this session (current fence ${outcome.current}); exiting\n`,
        shouldBreak: true,
      };
    case "aborted":
      return { text: `iris chat: turn aborted (${outcome.reason}); exiting\n`, shouldBreak: true };
  }
}

// --- streaming sink ----------------------------------------------------------

/** A live token sink for the chat REPL. `onDelta` is handed to the streaming
 *  model performer (a NON-journaled side-channel — live UX only); `begin` resets
 *  per-turn state; `wroteAny` tells `runChat`/`renderOutcome` whether the reply
 *  already streamed (so it is not printed a second time). */
export interface StreamSink {
  onDelta(text: string): void;
  begin(): void;
  wroteAny(): boolean;
}

/** Build a `StreamSink` over an output sink. On the FIRST non-empty delta of a
 *  turn it writes `prefix` (e.g. "agent> ") then the token; later non-empty
 *  deltas write just the token. An EMPTY delta is ignored — it never emits a
 *  spurious prefix and never flips `wroteAny`. Deltas are written WHOLE and
 *  verbatim — never re-sliced (UTF-8 rune-boundary safety lives in the SSE
 *  parser, which already snaps deltas to rune starts). `output` is typed exactly
 *  like `ChatDeps.output`, which already accepts `process.stdout` structurally. */
export function makeStreamSink(
  output: { write(s: string): void },
  prefix = "agent> ",
): StreamSink {
  let wrote = false;
  return {
    begin(): void {
      wrote = false;
    },
    onDelta(text: string): void {
      if (text === "") return;
      if (!wrote) {
        output.write(prefix);
        wrote = true;
      }
      output.write(text);
    },
    wroteAny(): boolean {
      return wrote;
    },
  };
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
  // When present, the model performer streams tokens to this sink's `onDelta`
  // (which writes to the SAME `output`). `runChat` resets it per turn and tells
  // `renderOutcome` the reply already streamed, so it is not printed twice.
  // Absent → buffered behavior (reply printed once after the turn parks).
  streamSink?: StreamSink;
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
      // Reset the sink BEFORE the turn so `wroteAny()` reflects only this turn's
      // live deltas (replay re-folds journaled history but never re-fires the
      // model performer, so older turns do not re-stream).
      deps.streamSink?.begin();
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
    const { text, shouldBreak } = renderOutcome(outcome, {
      streamed: deps.streamSink?.wroteAny() === true,
    });
    deps.output.write(text);
    if (shouldBreak) return; // finished / contended / aborted — a terminal outcome
    prompt();
  }
  // input ended (EOF / Ctrl-D) without an explicit /exit — the session stays put.
  deps.output.write(hint);
}
