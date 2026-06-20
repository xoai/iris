// Domain nouns for governance. Json-rideable → `type` aliases, NOT interfaces:
// these values ride a journaled `Json` (the signal_recv approval value), and an
// interface does not get the implicit `[k: string]: Json` index signature an object
// literal needs to be assignable to Json (convention: @irisrun/core harness/seams.ts:1-11).

// WHO is acting/approving. `id` is the stable principal identifier; `roles` drive
// role-based policy. Authenticating a principal (tokens/OAuth) is out of scope — the
// policy reasons over a SUPPLIED principal, it does not mint or verify one.
export type Principal = { id: string; roles?: string[] };

// WHAT is being gated: the projection of the tool call available at approval time.
// `callId` is the kernel's tool-call id (the parked `hitl:<callId>` signal); `name`
// is the tool name the policy reasons about.
export type GovernedAction = { name: string; callId: string };
