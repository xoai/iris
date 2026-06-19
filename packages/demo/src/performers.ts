// Host-side effect performers for the demo (clock + echo). Injected into the
// engine; never live in core. Both are deterministic in this slice.
import type { PerformerRegistry, LogicalClock, Json } from "@iris/core";

export function makeDemoPerformers(clock: LogicalClock): PerformerRegistry {
  return {
    clock: async () => ({ ok: true, value: clock.now() }),
    echo: async (request: Json) => ({ ok: true, value: request }),
  };
}
