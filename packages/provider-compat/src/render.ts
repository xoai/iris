// Deterministic markdown render of the compatibility matrix.
// Mirrors @irisrun/agent's `agentfileSchemaJson()`: a pure, stable string used in
// two places — the `iris providers --matrix` CLI output AND the table embedded in
// docs/06-providers.md, which a drift guard (tests/provider-compat-render.test.ts)
// pins to this output so the doc can NEVER silently diverge from the registry.
import { COMPAT_MATRIX, entriesByProtocol, type CompatEntry, type Protocol } from "./matrix.ts";

const PROTOCOL_HEADINGS: Record<Protocol, string> = {
  openai: "OpenAI Chat Completions protocol",
  anthropic: "Anthropic Messages protocol",
};

// The protocol order is fixed (openai then anthropic) so the render is stable
// regardless of matrix iteration; rows keep their matrix order within a protocol.
const PROTOCOL_ORDER: readonly Protocol[] = ["openai", "anthropic"];

function row(e: CompatEntry): string {
  // Column 3 carries the URL and, for a known-divergent endpoint, the divergence
  // note after an em dash. A replay-safe endpoint shows only its URL.
  const urlCell = e.note === "" ? `\`${e.baseUrl}\`` : `\`${e.baseUrl}\` — ${e.note}`;
  return `| ${e.label} | ${e.replaySafety} | ${urlCell} |`;
}

function section(p: Protocol): string {
  const rows = entriesByProtocol(p).map(row).join("\n");
  return [
    `### ${PROTOCOL_HEADINGS[p]}`,
    "",
    "| Endpoint | Replay safety | Endpoint URL · notes |",
    "| --- | --- | --- |",
    rows,
  ].join("\n");
}

/**
 * The full matrix as a deterministic markdown block (two protocol sections, each a
 * table). Called twice yields byte-identical output. Used by `iris providers --matrix`
 * and pinned into docs/06-providers.md by the drift guard.
 */
export function renderCompatMatrix(): string {
  // Touch COMPAT_MATRIX so a reader sees the data source; sections derive from it.
  void COMPAT_MATRIX;
  return PROTOCOL_ORDER.map(section).join("\n\n");
}
