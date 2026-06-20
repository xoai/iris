# Adding a tactic (and composing a bundle)

A **tactic** is how you change the way your agent thinks at one seam without
touching the kernel — and without breaking any session already on disk. If you
haven't read [The harness](../harness.md) yet, start there: it explains the five
seams, the precedence rules, and the one idea that makes all of this safe —
*decisions are recorded, not re-run*. This page is the contributor recipe for
writing your own.

The worked example throughout is `@irisrun/bundle-coding`, the first domain
bundle. It does exactly what you'll do: compose on `@irisrun/core`'s exported
tactics, override the one seam it cares about, and ship the `defaultBundle` shape.

## Step 1 — Write the tactic: a pure `decide`

A tactic is the smallest unit. The shape is `Tactic<Seam>` — an `id`, the `seam`
it plugs into, and a `decide` that maps that seam's input to its output:

```ts
export interface Tactic<S extends SeamName> {
  id: string;
  seam: S;
  decide(input: SeamIO[S]["in"]): SeamIO[S]["out"];
}
```

The type parameter is load-bearing. `Tactic<"gateAction">`'s `decide` receives
`{ call: ToolCall }` and must return a `GateChoice` — it has no way to reach
compaction, caps, or any other seam's input. That narrow signature *is* the remit
isolation guarantee; you couldn't widen a gate into the loop controller if you
tried.

Here is the coding bundle's gate. It's a factory function (not a bare object —
that's core's convention, and it lets you close over per-instance config), and the
`decide` is pure: read-only/codebase-search tools are a safe `allow`; everything
else is gated to `ask`:

```ts
const DEFAULT_READ_ONLY_TOOLS = ["read_file", "search", "list", "grep", "glob"] as const;

export function codingGate(readOnlyTools: string[] = []): Tactic<"gateAction"> {
  const safe = new Set<string>([...DEFAULT_READ_ONLY_TOOLS, ...readOnlyTools]);
  return {
    id: "iris/coding-gate",
    seam: "gateAction",
    decide: ({ call }): GateChoice => (safe.has(call.name) ? "allow" : "ask"),
  };
}
```

Two rules the example follows, and you should too:

- **No host imports.** `coding.ts` depends on `@irisrun/core` and nothing else —
  no Node, no transport, no filesystem. A tactic is a decision, not an effect. It
  *advises* the kernel; the kernel performs the effect. (The bundle's own header
  spells this out: `@irisrun/core` is the only dependency, and it stays
  byte-untouched.)
- **Be a pure function of the input.** `decide` is handed a read-only view and
  returns a `Json`-shaped choice. No I/O, no clocks, no globals. Step 3 explains
  why this matters less than you'd fear — but write it pure anyway, because the
  narrow types assume it.

A tactic may also *delegate*. `codingDecideNext` wraps core's `reactDecideNext`
verbatim — the ReAct tool-loop is already the right policy for a coding agent, so
there's nothing to tune today. It exists as a distinct factory only so a future
coding heuristic can layer in later without touching call sites:

```ts
export function codingDecideNext(): Tactic<"decideNext"> {
  const react = reactDecideNext();
  return {
    id: "iris/coding-decide",
    seam: "decideNext",
    decide: ({ state }): DecideNext => react.decide({ state }),
  };
}
```

That's a useful pattern in its own right: reuse a proven core tactic, keep your
own id and seam, and you've got a named seat to grow into.

## Step 2 — Compose a bundle

A **bundle** is one (or a chain) of tactics per seam, packaged as
`{ tacticPerformer, invariants }`. The contract you're implementing is `Bundle`:

```ts
export interface Bundle {
  tacticPerformer: Performer;
  invariants: Invariants;
}
```

The `tacticPerformer` is a single `Performer` — a function that, given a
`{ seam, payload }` request, runs that seam's composed chain and returns the
choice. You don't invent the routing; you reuse core's `compose*` helpers, which
encode the precedence rules from the harness chapter:

- `composeGate` — most-restrictive-wins (`deny` > `ask` > `allow`);
- `composeDecideNext` — first-decisive-wins (`continue` yields to the next tactic);
- `composeAssemble` — an ordered pipeline that threads `ctx` through each tactic.

Here is the coding bundle, assembled. Note what's *reused* (`reactAssembleContext`,
`windowCompaction`, `toolRepair`, `defaultInvariants`) and what's *overridden*
(`codingGate`, `codingDecideNext`) — and that the structure is identical to core's
`defaultBundle`:

```ts
export function codingBundle(opts: CodingBundleOptions = {}): Bundle {
  const assembleChain = [reactAssembleContext()];
  const decideChain = [codingDecideNext()];
  const gateChain = [codingGate(opts.readOnlyTools)];
  const compact = windowCompaction(opts.keepLast);
  const repair = toolRepair(opts.maxAttempts);

  const tacticPerformer: Performer = async (request: Json): Promise<Outcome> => {
    const req = request as { seam?: string; payload?: Json };
    const seam = req.seam ?? "";
    const payload = req.payload ?? null;
    let choice: Json;
    switch (seam) {
      case "assembleContext": {
        const pl = payload as { state: ReadonlyHarnessView; ctx: ModelContext };
        choice = composeAssemble(assembleChain, pl.state, pl.ctx);
        break;
      }
      case "shouldCompact": {
        const pl = payload as { ctx: ModelContext; budget: Budget };
        choice = compact.decide(pl);
        break;
      }
      case "gateAction": {
        const pl = payload as { call: ToolCall };
        choice = composeGate(gateChain, pl.call);
        break;
      }
      case "onToolError": {
        const pl = payload as { call: ToolCall; error: ErrorInfo; attempt: number };
        choice = repair.decide(pl);
        break;
      }
      case "decideNext": {
        const pl = payload as { state: ReadonlyHarnessView };
        choice = composeDecideNext(decideChain, pl.state);
        break;
      }
      default:
        return { ok: false, error: { message: `codingBundle: unknown seam '${seam}'` } };
    }
    return { ok: true, value: { seam, tacticId: BUNDLE_ID, choice } };
  };

  const invariants: Invariants = defaultInvariants(opts.invariants);
  return { tacticPerformer, invariants };
}
```

Three things to copy from this:

- **Override only what you mean to.** The coding bundle changes the gate (and
  reserves a decideNext seat); every other seam routes to a reused core tactic.
  You don't fork the loop to change the gate.
- **Reuse `defaultInvariants` for the caps.** The bundle sets the kernel's
  invariant caps — max steps and tool-calls per turn — a hard floor the kernel
  enforces regardless of what any tactic returns. `defaultInvariants(opts.invariants)`
  gives you that floor with optional overrides; you rarely need to hand-roll it.
- **Match `defaultBundle`'s shape exactly.** A bundle is structurally swappable
  with `default` precisely because it returns the same `{ tacticPerformer, invariants }`.
  Compare this `switch` to `defaultBundle` in core — the only differences are which
  tactics fill `decideChain` and `gateChain`, and the `tacticId` stamped on the
  outcome.

Everything imports from one place — `@irisrun/core` — and the package declares it
as its single dependency:

```ts
import {
  composeAssemble, composeDecideNext, composeGate,
  reactAssembleContext, reactDecideNext,
  windowCompaction, toolRepair, defaultInvariants,
} from "@irisrun/core";
import type {
  Json, Performer, Outcome, Invariants, Bundle, Tactic,
  GateChoice, DecideNext, Budget, ReadonlyHarnessView,
  ModelContext, ToolCall, ErrorInfo,
} from "@irisrun/core";
```

## Step 3 — Why this is replay-safe for free

This is the step that lets you write a tactic without fear, so it's worth seeing
plainly. Look at what the performer returns on success:

```ts
return { ok: true, value: { seam, tacticId: BUNDLE_ID, choice } };
```

That `{ seam, tacticId, choice }` is the journaled outcome — it rides the `tactic`
effect's result value, exactly like the default bundle. The replay contract is:
**the kernel folds the recorded `choice` and never re-invokes the tactic.** Your
`decide` runs once, when the decision is first made; on every replay after that,
the kernel reads the choice back from the journal.

Two consequences, both free:

- A tactic can be **nondeterministic or third-party** — it could call an LLM to
  decide — and replay still can't diverge, because replay reads the recorded
  choice rather than re-running `decide`. The coding bundle's header calls this the
  *replay quarantine*, and it applies to your external bundle unchanged: zero core
  changes, no special registration.
- You can **swap a bundle** without breaking a session already on disk. The
  journal holds the choices, not the tactic; the tactic that produced them no
  longer has to exist for the recorded session to replay identically.

So: write `decide` pure because the types ask you to and it keeps things simple —
but understand that even if it weren't, the journal would hold the line. That's the
whole reason a domain bundle is a few dozen lines of composition and not a fork of
the kernel.

## Checklist

- [ ] Each tactic is a `Tactic<Seam>` factory — `{ id, seam, decide }`, `decide`
      pure, no host imports.
- [ ] The bundle returns `{ tacticPerformer, invariants }` — the same shape as
      `defaultBundle`.
- [ ] Seams you don't specialize route to reused core tactics
      (`reactAssembleContext`, `windowCompaction`, `toolRepair`, …) via the
      `compose*` helpers.
- [ ] Caps come from `defaultInvariants` (override only the fields you need).
- [ ] The performer answers `{ seam, payload }` with
      `{ ok: true, value: { seam, tacticId, choice } }`, and returns
      `{ ok: false, error }` for an unknown seam.
- [ ] `@irisrun/core` is your only dependency.

## See also

- [The harness](../harness.md) — the concept chapter: the five seams, precedence,
  and the recorded-not-rerun model this recipe operationalizes.
- [Harness seams reference](../reference/harness-seams.md) — the normative seam
  contract: signatures, composition rules, and the journaled effect shape.
