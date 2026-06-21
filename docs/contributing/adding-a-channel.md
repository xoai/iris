# Adding a channel (a new transport behind the one port)

A **channel** is a wire in front of a **durable session** — and the wire is the only
part you write. The two-identifier protocol (mint a `sessionId`, own and rotate a
single-use `continuationToken`, claim in-flight atomically, refuse loudly) lives once
in `@irisrun/channel-core`, behind which every channel is interchangeable. If you
haven't read [Channels](../channels.md) yet, start there for the concept; the
[channel-port spec](../reference/channel-port-spec.md) is the normative contract this
recipe operationalizes. This page is the contributor recipe for adding a transport.

The worked example throughout is `@irisrun/channel-rest`, the in-process `node:http`
channel. It does exactly what you'll do: implement the `ChannelPort` mapping, drive
the shared `makeChannelSession`, map the refusal taxonomy to your transport's loud
error, and pass the conformance suite. REST, MCP, and Slack all drive the same driver
and run the same suite — which is the whole point.

> **Channel or bridge?** A channel is a **first-party** Iris transport. Reaching a
> non-first-party platform — Discord, Telegram, Teams — is a **bridge**: an external
> process (in any language) that speaks the existing REST wire protocol and needs no
> `@irisrun/*` package and no core change. If that's what you're building, stop here
> and read the [bridge pattern](../reference/bridge-pattern.md) instead. Promote a
> bridge to a first-party channel almost never — only when the platform is where the
> moat itself is demonstrated (which is why Slack is first-party and the rest are
> bridges).

> **Forkless: ship it as your own package (`--channel <module>`).** You no longer need a
> monorepo PR to add a first-party-grade channel. Export a single `openChannel(opts)`
> factory (from `@irisrun/sdk`) and select it with `iris serve --channel <module>`:
> ```ts
> import type { OpenChannel } from "@irisrun/sdk";
> export const openChannel: OpenChannel = (opts) => makeMyChannel(opts); // returns { listen, close }
> ```
> ```sh
> iris serve ./image --channel @acme/iris-channel-grpc
> ```
> `iris serve` dynamic-imports the module (no dependency added to Iris) and hands it the
> same `OpenChannelOptions` (≡ channel-rest's `RestChannelOptions`) it builds for the
> built-in `rest` transport; a module lacking `openChannel` is refused **loudly**. This
> **complements** the bridge pattern — bridges stay the any-language, no-package path;
> `--channel` is for an **in-process** channel that reuses `makeChannelSession`, the
> streaming `record`/`delta` vocabulary, and the held-connection `token:null` path.

## Step 1 — Don't write the protocol: drive `makeChannelSession`

The two-identifier protocol is not yours to reimplement. `makeChannelSession` owns it
in one place, and your transport supplies one thing — `runTurn`, the function that runs
a single turn over your host wiring:

```ts
const session = makeChannelSession<S>({
  runTurn: async (sessionId, body, emit) => {
    const inputs = await opts.makeTurnInputs(sessionId, body, emit);
    return runTurnOn(opts.adapter, { sessionId, ...inputs });
  },
  mintSessionId: opts.mintSessionId ?? (() => randomUUID()),
  mintToken: opts.mintToken ?? (() => randomUUID()),
});
```

That's the load-bearing reuse. `makeChannelSession` hands you back a `ChannelSession`
with exactly the operations a transport needs — and nothing it doesn't:

- `start(body, emit?)` — mint a session, run the first turn, issue a fresh token.
- `continueTurn(sessionId, presentedToken, body, emit?)` — validate the token, claim
  in-flight, run, rotate. The strict, buffered path.
- `validateContinue(sessionId, presentedToken)` / `inFlight(sessionId)` / `advance(...)`
  — the primitives a **streaming** transport uses to refuse *before* it opens a stream
  (more in Step 4).
- `currentToken` / `hasSession` / `newSessionId` — read-side helpers (the WS path binds
  a session to a held connection with `newSessionId`).

The token rotation, the single-use guard, and the refusal logic are all inside the
driver. You will *not* mint tokens, compare tokens, or decide when to rotate in your
transport code — if you find yourself doing that, you're reimplementing
`channel-core`, and you'll diverge from the spec.

**`mintSessionId` / `mintToken` are optional.** `channel-core` ships a
dependency-light fallback so it imports no host crypto; channel-rest injects
`randomUUID` from `node:crypto`. Inject your own host's generator the same way — that's
the one place host code crosses into the driver.

## Step 2 — Implement the `ChannelPort`: normalize in, emit out

A transport's job reduces to a single shape: turn a platform event into a channel
intent, drive the session, turn the result into a platform reply. That shape is
`ChannelPort<Platform, Reply>`:

```ts
export interface ChannelPort<Platform, Reply> {
  normalizeInbound(ev: Platform): Inbound;
  emitOutbound(result: StartResult<Json> | ContinueResult<Json>): Reply;
}
```

`Inbound` is the whole vocabulary of intents — there are exactly three:

```ts
export type Inbound =
  | { kind: "start"; body: Json }
  | { kind: "continue"; sessionId: string; token: string | null; body: Json }
  | { kind: "ignore" };
```

- **`start`** — a first message; the channel will mint a session.
- **`continue`** — carries the token the platform round-tripped. `token` is `null` when
  the transport authorizes by **connection** rather than a presented token (a held
  WebSocket), not when a token is missing — a missing token on a token-based continue
  is a loud refusal, not an `ignore`.
- **`ignore`** — a platform event the channel does not act on: a bot's own echo, a
  health ping, a handshake handled out of band.

In channel-rest, `normalizeInbound` is the HTTP routing itself: `POST /v1/session` is a
`start`; `POST /v1/session/{sessionId}/message` is a `continue` whose token comes from
the body's `continuationToken` or the `x-continuation-token` header; everything else is
a 404 or 405. The mapping is small on purpose — keep it that way, and the
spec-conformant behavior comes from the driver, not from your routing.

`emitOutbound` is the inverse: take a `StartResult` or `ContinueResult` and produce your
platform's reply shape. channel-rest's `turnResponse` builds the JSON body
(`{ sessionId, continuationToken, status, ... }`); a streaming transport instead emits
the shared wire events (Step 3).

## Step 3 — Use the one streaming-event vocabulary

If your transport streams, do not invent an event shape. `channel-core` homes one
vocabulary — `ChannelEvent` — that every transport shares:

```ts
export type ChannelEvent =
  | { type: "record"; record: Json }        // a committed JournalRecord (streaming-only)
  | { type: "delta"; text: string }         // a non-journaled model token (streaming-only)
  | { type: "outcome"; sessionId: string; status: ...; continuationToken?: string; ... }
  | { type: "error"; message: string };     // a mid-stream failure, surfaced loudly
```

`record` and `delta` are **streaming-only**: a buffered transport (channel-mcp, a
buffered Slack reply) simply passes no `emit` and never receives them — homing the full
union centrally is one vocabulary, not a push to make every channel stream. The
terminal `outcome` event is built by the exported `toOutcomeEvent(sessionId, outcome,
token?)`, which mirrors the buffered turn-response field-for-field so streaming and
buffered agree. channel-rest's SSE path is the whole pattern: stream `record`/`delta`
as the turn runs, then `emit(toOutcomeEvent(r.sessionId, r.outcome, r.token))` at the
end. (channel-rest re-exports `ChannelEvent` as `StreamEvent` and `toOutcomeEvent` from
`channel-core` for back-compat — they are the same symbols.)

## Step 4 — The refusal taxonomy: map every reason to a loud error

A continue is refused — **never a silent success** — for exactly four reasons. The
driver produces a `ChannelRefusal`; your transport maps each one to its loud error:

```ts
export type ChannelRefusal = "unknown-session" | "missing-token" | "stale-token" | "in-flight";
```

channel-rest's map (the REST and MCP columns of the spec's refusal table are exactly
these mappings):

```ts
const REFUSAL_STATUS: Record<ChannelRefusal, number> = {
  "unknown-session": 404,
  "missing-token": 400,
  "stale-token": 409,
  "in-flight": 409,
};
```

Two things the spec requires here, both visible in the driver — don't reimplement
either, just don't defeat them:

- **Committed-only rotation.** A turn produces one of four outcomes. `finished` and
  `parked` are **committed** (journaled progress) → the token rotates. `contended`
  (lease held elsewhere) and `aborted` (lease lost mid-flight) journaled **nothing** →
  the prior token is **kept**, so the client retries the same still-valid single-use
  credential. `issueToken` encodes this in one line: `if (priorToken !== null &&
  !COMMITTED.has(outcome.status)) return priorToken;`. Note that `contended`/`aborted`
  are normal `ok: true` outcomes that keep the token — they are **not** refusals.
- **Single-use under concurrency.** The in-flight claim is taken in the **same callback**
  as the token check, with **no `await` between**, so a second concurrent continue
  presenting the same valid token is refused — never double-applied. The loser is
  refused either as `in-flight` (caught before the winner rotated) or `stale-token` (the
  winner already rotated); both uphold single-use, and which one occurs depends only on
  scheduling.

**Streaming transports must refuse before opening the stream.** A loud refusal must
never become a half-open stream. That's why the driver exposes the primitives
separately: validate, peek in-flight, then advance — all without an `await` between the
check and the claim:

```ts
const refusal = session.validateContinue(sessionId, presented);
if (refusal) { /* send the loud 4xx, no stream opened */ return; }
if (session.inFlight(sessionId)) { /* loud 409 */ return; }
await runSse(res, async (emit) => {
  const r = await session.advance(sessionId, body, emit); // rotates only if committed
  /* ... */
});
```

The buffered path is simpler — `continueTurn` does the validate-then-advance for you in
one call and returns `{ ok: false, reason }` on refusal.

## Step 5 — Pass the conformance suite (the definition of a channel)

Passing the importable `@irisrun/channel-conformance` suite **is** the definition of a
first-class Iris channel — run it in your own CI. It drives behavior through your **real
transport surface** (it does not unit-test the driver). You provide a `ChannelPortFixture`
whose `create()` returns a `ChannelOps` adapter over your wire, and `setNext` flips an
underlying store so the suite can force `contended`/`aborted` through the real transport:

```ts
export interface ChannelOps {
  start(): Promise<{ sessionId: string; token: string }>;
  setNext(mode: "ok" | "contend" | "abort"): void;
  continueTurn(sessionId: string, token: string | null): Promise<ContinueOutcome>;
  close(): Promise<void>;
}
```

channel-rest's fixture (`tests/channel-port-rest.test.ts`) stands up a real
`makeRestChannel`, `listen()`s it, drives it with `fetch`, and maps HTTP status back to
a `Refusal` — only the wire mapping is transport-specific:

```ts
function mapRefusal(status: number, errorMessage: string): Refusal {
  if (status === 404) return "unknown-session";
  if (status === 400) return "missing-token";
  // 409 is both stale and in-flight — disambiguate by the loud message
  if (/in flight/i.test(errorMessage)) return "in-flight";
  return "stale-token";
}

import { test } from "node:test";
import { runChannelPortConformance, register } from "@irisrun/channel-conformance";

register(runChannelPortConformance({
  name: "channel-rest",
  async create(): Promise<ChannelOps> { /* listen(), drive with fetch, return ops */ },
}), test);
```

The suite is **runner-agnostic** — `runChannelPortConformance(fixture)` returns a list of
cases and `register(cases, test)` wires them into `node:test` (or any runner). Each case
calls `fx.create()` for a fresh channel. What the suite pins (and therefore what your
channel must satisfy):

- START mints a session and issues a non-empty token.
- A committed continue rotates the token.
- A stale token is refused loudly **and the prior token still works** (a refusal does
  not rotate).
- A missing token is refused loudly.
- An unknown session is refused loudly.
- A `contended` turn **keeps** the prior token (it's a normal outcome, not a refusal).
- An `aborted` turn **keeps** the prior token.
- The token is single-use under concurrency: two same-token continues → exactly one
  wins, the other is refused `in-flight` **or** `stale-token`.
- A **replayed** token (from a prior, already-rotated turn) and a **cross-session** token
  are both refused `stale-token`; an empty-string token is `missing-token` (not stale); a
  garbage sessionId is `unknown-session` (never a crash); and every refusal is within the
  four-value taxonomy.
- A non-committed chain (contended → contended → finished) keeps the token across the
  non-committed turns and rotates exactly once on the commit.
- **Opt-in:** a held-connection (WebSocket / gRPC) transport supplies
  `fixture.holdConnection` to certify the `token:null` advance path — advance without a
  presented token, rotate on commit, and a second concurrent advance is `in-flight`.

## Step 6 — Stay host-light at the seam

channel-rest depends on exactly three packages — `@irisrun/core` (types),
`@irisrun/channel-core` (the port), and `@irisrun/host` (`runTurnOn`) — plus
`node:http`/`node:crypto` from the platform. `channel-core` itself depends only on
`@irisrun/core` types and imports no host crypto, which is why minting is injected. Keep
that line: the driver stays pure and portable, and the host specifics (sockets, crypto,
framing) live in your transport. A capability that the host doesn't advertise is
refused **loudly** too — channel-rest refuses a WebSocket upgrade with a `426` when the
adapter doesn't advertise `websockets`, never a silent downgrade.

## Checklist

- [ ] You drive `makeChannelSession` — you do **not** mint, compare, or rotate tokens in
      transport code, and you do **not** decide when to rotate.
- [ ] `normalizeInbound` maps every platform event to `start` · `continue` · `ignore`;
      `emitOutbound` maps a `StartResult` / `ContinueResult` to your reply shape.
- [ ] A `continue` carries the round-tripped token; `token: null` means
      authorize-by-connection (a held socket), not a missing token.
- [ ] Streaming uses the shared `ChannelEvent` vocabulary and `toOutcomeEvent` — you do
      **not** invent an event shape; `record`/`delta` are streaming-only.
- [ ] Every `ChannelRefusal` (`unknown-session` · `missing-token` · `stale-token` ·
      `in-flight`) maps to a loud transport error — never a silent success.
- [ ] A streaming transport refuses (`validateContinue` + `inFlight`) **before** opening
      the stream, with no `await` between the check and `advance`.
- [ ] `contended` / `aborted` keep the prior token; only `finished` / `parked` rotate.
- [ ] You register `runChannelPortConformance(fixture)` synchronously at module load,
      drive it through your **real** transport, and all eight assertions pass.
- [ ] Your dependencies stay narrow: `@irisrun/core` + `@irisrun/channel-core`
      (+ `@irisrun/host` for `runTurnOn`); host crypto is injected, not imported into the
      driver.
- [ ] If the target is a non-first-party platform, you built a **bridge**, not a channel.

## See also

- [Channels](../channels.md) — the concept chapter: durable sessions, serving over HTTP,
  the two-identifier protocol, and the client SDK.
- [Channel-port spec](../reference/channel-port-spec.md) — the **normative** contract
  this recipe operationalizes: the two identifiers, committed-only rotation, the refusal
  taxonomy, single-use under concurrency, and conformance.
- [Bridge pattern](../reference/bridge-pattern.md) — for a non-first-party platform: an
  external process that speaks the REST wire protocol with **no** `@irisrun/*` dependency
  and **no** core change.
- [Architecture](../architecture.md) — where the channel port sits among the ports
  (StateStore, host adapter) and why narrow seams keep the system pluggable.
