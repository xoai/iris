# Harness seams (normative)

The contract a tactic — and the bundle that packs tactics together — implements.
This is the normative companion to [The harness](../harness.md): that chapter explains
*why* the loop is assembled from swappable tactics at five seams and journals every
decision; this page is the spec a contributor builds against. Types here are quoted
from `packages/core/src/harness/seams.ts`, `bundle.ts`, and `invariants.ts` and must
match the source exactly.

> Reference, not tutorial. To *write* a tactic, follow the
> [adding a tactic guide](../contributing/adding-a-tactic.md).

## The five seams

A seam is a typed decision point. Each seam is a pure `decide(input) -> output`; a
tactic plugs into exactly one and its signature physically cannot reach another seam's
concern. The names live in `SeamName`:

```ts
export type SeamName =
  | "assembleContext"
  | "shouldCompact"
  | "decideNext"
  | "gateAction"
  | "onToolError";
```

`planStep` and `spawnPolicy` are **deferred** (not shipped). Widening a seam later is
safe; narrowing is breaking — so core ships the minimal five.

### Seam `in` / `out` types

The typed signatures are the `SeamIO` interface. Each seam declares an exact input and
output shape:

| Seam | `in` | `out` |
|---|---|---|
| `assembleContext` | `{ state: ReadonlyHarnessView; ctx: ModelContext }` | `ModelContext` |
| `shouldCompact` | `{ ctx: ModelContext; budget: Budget }` | `false \| ModelContext` |
| `decideNext` | `{ state: ReadonlyHarnessView }` | `DecideNext` |
| `gateAction` | `{ call: ToolCall }` | `GateChoice` |
| `onToolError` | `{ call: ToolCall; error: ErrorInfo; attempt: number }` | `ToolErrorChoice` |

All seam IO is `Json`-shaped, because a decision rides the `tactic` effect's result
value. The supporting structs are `type` aliases (not `interface`s) precisely so an
object literal stays assignable to `Json`'s implicit index signature.

### Supporting IO types

Quoted exactly from `seams.ts`:

```ts
export type ModelMessage = { role: string; content: string };
export type ModelContext = { messages: ModelMessage[]; tokens?: number };
export type Budget = { tokens?: number; toolCalls?: number };
export type ToolCall = { callId: string; name: string; args: Json };
export type ErrorInfo = { message: string; code?: string; fix?: Json };

export type ReadonlyHarnessView = {
  phase: string;
  ctx: ModelContext | null;
  modelOut: Json;
  steps: number;
  toolCalls: number;
};
```

- `ReadonlyHarnessView` is a read-only projection of the harness state handed to the
  context and decision seams. The read-only contract is upheld by tactic purity — a
  tactic mutating its input could not affect the journaled state anyway.
- `ErrorInfo.fix` is an **optional** structured correction a tool may suggest on a
  schema error; the `onToolError` tactic applies it as a patch.

### Output unions

```ts
export type DecideNext = "continue" | { wait: WaitSpec } | "finish";
export type GateChoice = "allow" | "deny" | "ask";
export type ToolErrorChoice = { action: "retry" | "repair" | "giveUp"; patch?: Json };
```

`shouldCompact`'s output is `false | ModelContext`: `false` means no compaction; a
`ModelContext` *is* the compacted context — the decision is the result, so replay
reproduces it without re-running the compactor. `WaitSpec` (in `DecideNext`) is the
journal's wait descriptor (`{ kind: "user" }`, `{ kind: "signal"; name }`, or
`{ kind: "timer"; at }`), imported from `../journal.ts`.

## The `Tactic<S>` interface

A tactic is a single decision function bound to one seam, generic over the seam name:

```ts
export interface Tactic<S extends SeamName> {
  id: string;
  seam: S;
  decide(input: SeamIO[S]["in"]): SeamIO[S]["out"];
}
```

The generic `S` ties `decide`'s input and output to the chosen seam via `SeamIO[S]`:
a `Tactic<"gateAction">` takes `{ call: ToolCall }` and returns `GateChoice`, and the
type system rejects any cross-seam wiring. The `id` is the string recorded in the
journal (see the effect shape below); `seam` is the seam the tactic plugs into.

A `TacticChain<S>` is just an ordered, read-only list of same-seam tactics:

```ts
export type TacticChain<S extends SeamName> = ReadonlyArray<Tactic<S>>;
```

## Composition rules per seam

Three seams compose a chain; the rule differs by seam, and each rule lives in a pure
function in `seams.ts`. The other two seams (`shouldCompact`, `onToolError`) are
single-tactic in the default bundle and consulted by calling `decide` directly.

### `gateAction` — most-restrictive-wins

`composeGate` ranks choices `allow (0) < ask (1) < deny (2)` and keeps the worst across
the chain. An empty chain returns `"allow"` (the neutral identity).

```ts
const GATE_RANK: Record<GateChoice, number> = { allow: 0, ask: 1, deny: 2 };

export function composeGate(chain: TacticChain<"gateAction">, call: ToolCall): GateChoice {
  let worst: GateChoice = "allow";
  for (const t of chain) {
    const choice = t.decide({ call });
    if (GATE_RANK[choice] > GATE_RANK[worst]) worst = choice;
  }
  return worst;
}
```

The kernel's invariant layer applies the secure gate-irreversible-by-default
separately (see [Invariant caps](#invariant-caps)); composition itself is purely the
most-restrictive fold.

### `decideNext` — first-decisive-wins

`composeDecideNext` returns the first choice that is **not** `"continue"`. `"continue"`
is not decisive, so it yields to the next tactic; if every tactic says `"continue"`,
the loop continues.

```ts
export function composeDecideNext(
  chain: TacticChain<"decideNext">,
  state: ReadonlyHarnessView,
): DecideNext {
  for (const t of chain) {
    const decision = t.decide({ state });
    if (decision !== "continue") return decision;
  }
  return "continue";
}
```

### `assembleContext` — ordered pipeline

`composeAssemble` reduces the chain, threading the accumulated `ModelContext` through
each tactic. The seed is an empty context `{ messages: [] }` unless one is supplied.

```ts
export function composeAssemble(
  chain: TacticChain<"assembleContext">,
  state: ReadonlyHarnessView,
  seed: ModelContext = { messages: [] },
): ModelContext {
  return chain.reduce((ctx, t) => t.decide({ state, ctx }), seed);
}
```

## The journaled effect: `{ seam, tacticId, choice }`

A seam consultation is performed host-side as a `tactic` effect, exactly like a
`model_call`, so replay never re-invokes the tactic — the kernel folds the recorded
`choice` and moves on.

A **bundle** packs the tactics into one `Performer` plus the kernel caps:

```ts
export interface Bundle {
  tacticPerformer: Performer;
  invariants: Invariants;
}
```

The `tacticPerformer` answers a **request** of shape `{ seam, payload }` and returns a
**result value** of shape `{ seam, tacticId, choice }`. From `defaultBundle()` in
`bundle.ts`, the performer:

1. reads `seam` and `payload` off the request (`seam ?? ""`, `payload ?? null`);
2. switches on `seam`, casts `payload` to that seam's `in` type, and runs the seam's
   composed chain (`composeAssemble` / `composeGate` / `composeDecideNext`) or the
   single tactic's `decide` (`shouldCompact`, `onToolError`) to produce `choice`;
3. returns `{ ok: true, value: { seam, tacticId, choice } }`.

In `defaultBundle`, `tacticId` is the literal `"default-bundle"`. An unknown seam
returns `{ ok: false, error: { message: "defaultBundle: unknown seam '<seam>'" } }`.
The `Performer` / `Outcome` types come from `../program.ts`:

```ts
export type Outcome =
  | { ok: true; value: Json }
  | { ok: false; error: { message: string; code?: string } };

export type Performer = (
  request: Json,
  idempotencyKey?: string,
) => Promise<Outcome>;
```

The performer is **built in core but wired into the `PerformerRegistry` by the
runner/host** — core never injects performers itself. The journaled
`{ seam, tacticId, choice }` is what makes a bundle replay-safe with zero core changes:
a tactic may be nondeterministic or third-party, and replay still cannot diverge
because it reads the recorded `choice`.

### `defaultBundle` options

`defaultBundle(opts)` accepts:

```ts
export interface DefaultBundleOptions {
  safeTools?: string[];
  keepLast?: number;
  maxAttempts?: number;
  invariants?: { maxStepsPerTurn?: number; maxToolCalls?: number };
}
```

It builds the default chains — `reactAssembleContext()` for `assembleContext`,
`reactDecideNext()` for `decideNext`, `approveIrreversible(opts.safeTools)` for
`gateAction` — plus the single `windowCompaction(opts.keepLast)` and
`toolRepair(opts.maxAttempts)` tactics, and returns the `Bundle` with
`defaultInvariants(opts.invariants)`.

## Invariant caps

Caps are a **runtime kernel override**, distinct from the type-enforced remit
isolation. No seam has any cap input or output, so a tactic literally cannot read or
raise a cap (a compile-time guarantee). Caps live **only** in `Invariants`; the kernel
enforces them in the reducer by forcing the loop to `done` when a journaled counter
exceeds a cap, regardless of what any tactic returned.

```ts
export interface Invariants {
  maxStepsPerTurn: number;
  maxToolCalls?: number; // optional hard cap on successful tool calls
  gateIrreversibleByDefault: true; // pinned: cannot be loosened to false
  egressDefault: "deny-all"; // pinned: no runtime network yet (enforced for real later)
}
```

- **`maxStepsPerTurn`** — hard cap on loop steps (one step per effect), bounding every
  runaway: assemble loops *and* tool-error retry storms. A "turn" is the whole loop
  from initial state to `finish`; in this slice that spans the entire session,
  including park/resume cycles, so `steps` is not reset across resumes.
- **`maxToolCalls`** — optional hard cap on successful tool calls.
- **`gateIrreversibleByDefault: true`** and **`egressDefault: "deny-all"`** are pinned
  to single literal values by the type; config may only **tighten**, never loosen them.

`defaultInvariants` sets `maxStepsPerTurn` to `64` unless overridden, always pins
`gateIrreversibleByDefault: true` and `egressDefault: "deny-all"`, and only sets
`maxToolCalls` when an override is supplied:

```ts
export function defaultInvariants(
  overrides: { maxStepsPerTurn?: number; maxToolCalls?: number } = {},
): Invariants {
  const inv: Invariants = {
    maxStepsPerTurn: overrides.maxStepsPerTurn ?? 64,
    gateIrreversibleByDefault: true,
    egressDefault: "deny-all",
  };
  if (overrides.maxToolCalls !== undefined) inv.maxToolCalls = overrides.maxToolCalls;
  return inv;
}
```

Enforcement is a pure function reading only journaled state, so the override replays
deterministically:

```ts
export function enforceInvariants(state: HarnessState, inv: Invariants): Phase | null {
  if (state.steps > inv.maxStepsPerTurn) return "done";
  if (inv.maxToolCalls !== undefined && state.toolCalls > inv.maxToolCalls) return "done";
  return null;
}
```

Token budgeting is **not** an invariant here: it drives compaction via
`HarnessConfig.budget`, not a halt — a cap that isn't enforced would be a lie.

## What a tactic/bundle must satisfy

To be a conforming tactic or bundle:

1. Each tactic implements `Tactic<S>` for exactly one seam — `{ id, seam, decide }` —
   with `decide` matching that seam's `SeamIO[S]["in"]` and `SeamIO[S]["out"]` exactly.
2. Composition respects the seam's rule: most-restrictive-wins for `gateAction`,
   first-decisive-wins for `decideNext`, ordered pipeline for `assembleContext`.
3. The bundle exposes `{ tacticPerformer, invariants }`; the performer answers a
   `{ seam, payload }` request with `{ seam, tacticId, choice }` (or a loud `ok: false`
   on an unknown seam).
4. The kernel's `Invariants` caps bound every tactic — a tactic cannot read or raise
   them.

---

Back to **[The harness](../harness.md)** · source: `packages/core/src/harness/`
(`seams.ts`, `bundle.ts`, `invariants.ts`).
