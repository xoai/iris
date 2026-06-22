// Pluggable bridge selection for `iris bridge`. A bridge makes a chat platform
// (Discord, Telegram, WhatsApp, …) reachable by speaking the Iris REST channel wire
// protocol. `iris bridge <module>` dynamic-imports ANY module that exports
// `openBridge(opts)` (an @irisrun/bridge OpenBridge) and serves it in front of a running
// channel — so a bridge is selectable by module specifier, exactly the way `--store` and
// `--channel` already work. A module that fails to import or lacks the export is refused
// LOUDLY. The CLI dynamic-imports it, so it adds NO dependency to Iris — the bridge is the
// operator's module.
import type { OpenBridge } from "@irisrun/bridge";

/** Resolve a bridge module specifier to its `openBridge` factory. Mirrors
 *  `resolveChannel`/`resolveStore`: load loudly, refuse a missing/wrong export loudly. */
export async function resolveBridge(spec: string): Promise<OpenBridge> {
  let mod: { openBridge?: OpenBridge };
  try {
    mod = (await import(spec)) as { openBridge?: OpenBridge };
  } catch (e) {
    throw new Error(
      `iris: bridge "${spec}" — could not import the bridge module (${(e as Error).message}). ` +
        "Provide a module that exports openBridge(opts) — see docs/reference/bridge-pattern.md.",
    );
  }
  if (typeof mod.openBridge !== "function") {
    throw new Error(
      `iris: bridge "${spec}" must export openBridge(opts) — see docs/reference/bridge-pattern.md`,
    );
  }
  return mod.openBridge;
}
