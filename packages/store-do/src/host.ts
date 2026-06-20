// edgeHost — the Cloudflare/edge HostAdapter factory. Returns the
// {name, capabilities, store, scheduler} shape `runTurnOn` consumes, wiring a
// DoStateStore + DoScheduler over the given DoStorage. The capability profile is
// REMOTE-ONLY: long_running:false (an isolate does not hold a turn across
// invocations — it parks on the DO alarm), local_subprocess:false +
// tool_locality:"remote" (edge tools are remote MCP only). This is the profile
// the capability gate refuses an over-capable image against. The default
// name "Cloudflare" is BOTH the stable per-host writer identity AND the target
// label the refusal message interpolates — so the rendered refusal is
// byte-identical to the example.
//
// The package deps only @irisrun/core, so the HostAdapter SHAPE is declared
// structurally here (HostAdapter from @irisrun/host is structurally identical); the
// capabilities object matches @irisrun/agent's CapabilityProfile field-for-field.
import type { StateStore, Scheduler } from "@irisrun/core";
import { DoStateStore } from "./store.ts";
import { DoScheduler } from "./scheduler.ts";
import type { DoStorage } from "./do-storage.ts";

// Structurally identical to @irisrun/host's HostAdapter (avoids a host/agent dep —
// the package stays @irisrun/core-only per the workstream boundary).
export interface EdgeHostAdapter {
  name: string;
  capabilities: {
    long_running: boolean;
    filesystem: boolean;
    local_subprocess: boolean;
    websockets: boolean;
    tool_locality: "remote";
  };
  store: StateStore;
  scheduler: Scheduler;
}

export function edgeHost(storage: DoStorage, name = "Cloudflare"): EdgeHostAdapter {
  return {
    name,
    capabilities: {
      long_running: false,
      filesystem: false,
      local_subprocess: false,
      websockets: false,
      tool_locality: "remote",
    },
    store: new DoStateStore(storage),
    scheduler: new DoScheduler(storage),
  };
}
