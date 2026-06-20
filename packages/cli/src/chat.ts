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
import { subagentPerformers, type CliSubagents } from "./iris.ts";
import { makeGovernedApprovalPerformer, decideApproval } from "@iris/auth";
import type { ApprovalPolicy, ApprovalInbox, Principal } from "@iris/auth";

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

// --- HITL approval (in-chat) -------------------------------------------------

/** A pending human-in-the-loop approval: the tool call the agent gated to "ask",
 *  surfaced for an inline approve/deny. `callId` is the parked `hitl:<callId>`
 *  signal's id (the inbox key the governed `signal_recv` performer reads). */
export interface HitlRequest {
  callId: string;
  name: string;
  args: Json;
}

/** If `outcome` parked on a HITL approval signal (`hitl:<callId>`), return the
 *  pending tool call (name + args); otherwise null. PURE and TOTAL — every Json
 *  shape is guarded and it never throws. The current tool call is read INLINE from
 *  the parked `HarnessState` (the kernel's `toolCallsOf`/`currentToolCall` are
 *  private to @iris/core): `state.modelOut.toolCalls[state.toolCursor]`. The
 *  authoritative `callId` is taken from the signal name (what the inbox is keyed
 *  on); the call's own name/args are for display. A malformed/absent call still
 *  yields a request (with empty name) so the human can still decide. */
export function hitlRequest(outcome: TurnOutcome<HarnessState>): HitlRequest | null {
  if (outcome.status !== "parked") return null;
  const wait = outcome.wait;
  if (wait.kind !== "signal" || !wait.name.startsWith("hitl:")) return null;
  const callId = wait.name.slice("hitl:".length);
  const state = outcome.state;
  const modelOut = state.modelOut;
  if (modelOut === null || typeof modelOut !== "object" || Array.isArray(modelOut)) {
    return { callId, name: "", args: null };
  }
  const toolCalls = (modelOut as { toolCalls?: Json }).toolCalls;
  const cursor = typeof state.toolCursor === "number" ? state.toolCursor : 0;
  const call = Array.isArray(toolCalls) ? toolCalls[cursor] : undefined;
  if (call === null || typeof call !== "object" || Array.isArray(call)) {
    return { callId, name: "", args: null };
  }
  const c = call as { name?: Json; args?: Json };
  return { callId, name: typeof c.name === "string" ? c.name : "", args: c.args ?? null };
}

/** Map a REPL line to an approval intent. `y|yes|approve|a` → approve,
 *  `n|no|deny|d` → deny (case-insensitive, trimmed); anything else → null
 *  (the caller re-prompts). PURE. */
export function parseApproval(line: string): "approve" | "deny" | null {
  const s = line.trim().toLowerCase();
  if (s === "y" || s === "yes" || s === "approve" || s === "a") return "approve";
  if (s === "n" || s === "no" || s === "deny" || s === "d") return "deny";
  return null;
}

/** The inline approval prompt for a parked HITL request. PURE. When `opts.streamed`
 *  is true (the tool-call turn already streamed text to the current line), lead with
 *  a newline so the prompt starts on its own line. */
export function renderHitlRequest(req: HitlRequest, opts: { streamed?: boolean } = {}): string {
  const lead = opts.streamed === true ? "\n" : "";
  const args = JSON.stringify(req.args ?? null);
  return (
    `${lead}⚠️ approval needed — the agent wants to run tool '${req.name}' ` +
    `(call ${req.callId}) with args ${args}\n` +
    `approve? [y/n] `
  );
}

/** What to print after an approval decision is recorded. PURE. `ran` is whether the
 *  governed decision actually runs the tool (approve + authorized); `reason` is the
 *  GovernedApproval explanation (policy verdict) when present. */
export function renderApprovalResult(input: {
  intent: "approve" | "deny";
  ran: boolean;
  reason?: string;
}): string {
  const verb = input.ran
    ? "approved — running the tool"
    : input.intent === "deny"
      ? "denied — skipping the tool"
      : "not authorized — skipping the tool";
  return `· ${verb}${input.reason ? ` (${input.reason})` : ""}\n`;
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
  // Opt-in subagent delegation (P2-9). Absent → no `subagent` effect, no subagentTools
  // (byte-identical chat registry). The delegate names must ALSO be in the safeTools of
  // the injected tacticPerformer's bundle (built by cli-main) so a delegation doesn't
  // park on the gate.
  subagents?: CliSubagents;
  // Opt-in in-chat HITL governance. When present, a tool call gated to "ask" parks on
  // a `hitl:<callId>` signal and `runChat` resolves it INLINE: it surfaces the pending
  // call, reads an approve/deny line, records the decision in `inbox`, and resumes the
  // durable session (running or skipping the tool). The journaled `GovernedApproval` is
  // identical to serve's, so `iris audit` sees chat approvals too. ABSENT → a hitl park
  // renders the legacy "not resumable from chat yet" line (byte-identical ungoverned
  // path; the `signal_recv` performer is not even registered).
  governance?: { policy: ApprovalPolicy; inbox: ApprovalInbox };
  // The approver identity stamped on each decision (audit). Defaults to
  // `{ id: "local", roles: ["operator"] }` when governance is present.
  principal?: Principal;
}

/** Assemble the per-turn performer registry. With `message` set (a new user turn),
 *  `user_recv` delivers it; without (a HITL resume turn, which re-enters at
 *  `recv_hitl`, never `recv_user`), `user_recv` is a defensive throw that the
 *  per-turn try/catch isolates if the contract is ever violated. The governed
 *  `signal_recv` performer is registered ONLY when governance is wired — absent it,
 *  the registry is byte-identical to the pre-HITL chat. */
function chatPerformers(deps: ChatDeps, message?: string): PerformerRegistry {
  const performers: PerformerRegistry = {
    tactic: deps.tacticPerformer,
    model_call: deps.modelPerformer,
    user_recv:
      message !== undefined
        ? async () => ({ ok: true, value: { content: message } })
        : async () => {
            throw new Error("iris chat: unexpected user_recv during a HITL resume");
          },
    ...subagentPerformers(deps.subagents, deps.sessionId),
  };
  if (deps.toolPerformer) performers.tool_call = deps.toolPerformer;
  if (deps.governance) performers.signal_recv = makeGovernedApprovalPerformer(deps.governance);
  return performers;
}

/** Drive ONE turn against the durable session with a prepared registry. Shared by
 *  `chatTurn` (a user message) and `resumeTurn` (a HITL approval resume). */
function runChatTurn(deps: ChatDeps, performers: PerformerRegistry): Promise<TurnOutcome<HarnessState>> {
  const subNames = deps.subagents?.names ?? [];
  return runTurn<HarnessState>(
    {
      store: deps.store,
      scheduler: deps.scheduler,
      clock: deps.clock,
      program: harnessProgram(
        { messages: [] },
        subNames.length ? { interactive: true, subagentTools: subNames } : { interactive: true },
      ),
      performers,
      defDigest: deps.defDigest,
      holderId: "iris-chat",
      assertReplay: true,
    },
    deps.sessionId,
  );
}

/** Run ONE user message as a turn against the durable session. The message is
 *  delivered via a per-turn `user_recv` performer (journaled → deterministic). */
export async function chatTurn(deps: ChatDeps, message: string): Promise<TurnOutcome<HarnessState>> {
  return runChatTurn(deps, chatPerformers(deps, message));
}

/** Resume a session parked on a HITL approval signal. The decision must already be in
 *  the inbox; the turn re-enters at `recv_hitl`, emits `signal_recv`, and the governed
 *  performer reads the recorded decision — running or skipping the gated tool. No user
 *  message is delivered (the resume turn never reaches `recv_user`). */
export async function resumeTurn(deps: ChatDeps): Promise<TurnOutcome<HarnessState>> {
  return runChatTurn(deps, chatPerformers(deps));
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
  const approvalPrompt = (): void => {
    if (deps.isInteractive) deps.output.write("approve> ");
  };
  const hint = "(session is durable — resume later with the same --session and --db)\n";
  const pendingHint =
    "(session parked awaiting your approval — resume with the same --session and --db to decide)\n";

  // The approver identity stamped on each decision; only meaningful when governance
  // is wired. Defaults to a local operator.
  const principal: Principal = deps.principal ?? { id: "local", roles: ["operator"] };

  // Set while a turn is parked on a HITL approval; the next line is then read as an
  // approve/deny answer rather than a new message. Only ever armed when governance is
  // wired (the ungoverned path keeps the legacy render and never sets this). It is
  // reassigned from `handle`'s RETURN (not mutated in a closure) so the loop's control
  // flow narrows it correctly.
  let pending: HitlRequest | null = null;

  // Examine a turn outcome: a HITL park (governance on) renders the request and returns
  // it as the new `pending`; anything else renders via `renderOutcome`. `stop` is whether
  // the loop should end (a terminal outcome).
  const handle = (
    outcome: TurnOutcome<HarnessState>,
  ): { pending: HitlRequest | null; stop: boolean } => {
    const req = deps.governance ? hitlRequest(outcome) : null;
    if (req !== null) {
      deps.output.write(renderHitlRequest(req, { streamed: deps.streamSink?.wroteAny() === true }));
      return { pending: req, stop: false };
    }
    const { text, shouldBreak } = renderOutcome(outcome, {
      streamed: deps.streamSink?.wroteAny() === true,
    });
    deps.output.write(text);
    return { pending: null, stop: shouldBreak };
  };

  prompt();
  for await (const raw of deps.input) {
    const line = raw.trim();
    if (line === "") {
      if (pending) approvalPrompt();
      else prompt();
      continue;
    }
    // /exit and /quit work in both modes. With an approval pending, do NOT fabricate a
    // decision — the session stays parked, resumable later (chat or serve).
    if (line === "/exit" || line === "/quit") {
      deps.output.write(pending ? pendingHint : hint);
      return;
    }

    if (pending) {
      // Interpret the line as an approve/deny answer.
      const intent = parseApproval(line);
      if (intent === null) {
        deps.output.write("· please answer y (approve) or n (deny)\n");
        approvalPrompt();
        continue;
      }
      const gov = deps.governance;
      if (!gov) {
        // Unreachable (pending is only armed when governance is on); fail safe.
        pending = null;
        prompt();
        continue;
      }
      const action = { name: pending.name, callId: pending.callId };
      gov.inbox.submit(action, { principal, intent });
      // Compute the decision locally for display — the SAME pure function the governed
      // performer applies on resume, so the printed verdict matches what runs.
      const decision = decideApproval({ policy: gov.policy, principal, intent, action });
      deps.output.write(renderApprovalResult({ intent, ran: decision.approved, reason: decision.reason }));
      let outcome: TurnOutcome<HarnessState>;
      try {
        deps.streamSink?.begin();
        outcome = await resumeTurn(deps);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.output.write(`iris chat: resume failed (${msg}); session preserved — try again\n`);
        pending = null;
        prompt();
        continue;
      }
      const res = handle(outcome);
      pending = res.pending;
      if (res.stop) return;
      if (pending) approvalPrompt();
      else prompt();
      continue;
    }

    // A normal user message.
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
    const res = handle(outcome); // finished / contended / aborted — a terminal outcome
    pending = res.pending;
    if (res.stop) return;
    if (pending) approvalPrompt();
    else prompt();
  }
  // input ended (EOF / Ctrl-D) without an explicit /exit — the session stays put.
  deps.output.write(pending ? pendingHint : hint);
}
