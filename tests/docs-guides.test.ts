// Docs-guides integrity. The funnel guard (docs-funnel.test.ts) scans README +
// the Concept funnel pages but NOT docs/guides/*. These guides carry library code
// and CLI commands, so guard them the same way the funnel guards its pages: every
// relative link resolves to a real file, and every `iris <cmd>` in a fenced block
// is a real CLI command. Add a guide to GUIDES to bring it under the guard.
//
// Note vs docs-funnel: funnel pages live directly in docs/, so it resolves links
// against DOCS. Guides live in docs/guides/, so a link like `../tools.md` is
// relative to the GUIDE's own directory — resolve against that, not DOCS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(ROOT, "docs");

const GUIDES = ["guides/connections.md", "guides/sandbox.md"];

test("docs-guides: every guarded guide exists", () => {
  for (const f of GUIDES) assert.ok(existsSync(join(DOCS, f)), `missing docs/${f}`);
});

test("docs-guides: every relative markdown link resolves to a real file", () => {
  for (const f of GUIDES) {
    const path = join(DOCS, f);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1];
      if (/^https?:/.test(raw) || raw.startsWith("#")) continue; // external / in-page anchor
      const target = raw.split("#")[0]; // strip any fragment
      if (target === "") continue;
      const resolved = resolve(dirname(path), target); // relative to the guide's own dir
      assert.ok(existsSync(resolved), `docs/${f}: broken relative link "${raw}" (→ ${resolved})`);
    }
  }
});

test("docs-guides: every `iris <cmd>` in a code block is a real CLI command", () => {
  // valid commands = the cli-main.ts dispatcher's switch cases (source of truth),
  // exactly as docs-funnel.test.ts derives them.
  const cliMain = readFileSync(join(ROOT, "packages", "cli", "src", "cli-main.ts"), "utf8");
  const cmds = new Set([...cliMain.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]));
  assert.ok(
    cmds.has("serve") && cmds.has("chat") && cmds.has("inspect"),
    "sanity: parsed the CLI command set from cli-main.ts",
  );
  // Same invocation pattern as docs-funnel: treat `iris <word>` as a CLI call only
  // at a command position (line start, or after a pipe / && / ; / `npx ` / an
  // env-assignment prefix). The capture stops at the first space, so flags like
  // `--mcp` / `--policy` never trip it; a fictional `iris connect` would fail.
  const invocation = /(?:^|\||&&|;|\bnpx\s+|\b[A-Z_]+=\S+\s+)\s*iris\s+([a-z][a-z-]*)/gm;
  for (const f of GUIDES) {
    const text = readFileSync(join(DOCS, f), "utf8");
    const blocks = text.split("```");
    for (let i = 1; i < blocks.length; i += 2) {
      // odd segments are inside fenced code blocks
      for (const m of blocks[i].matchAll(invocation)) {
        const cmd = m[1];
        assert.ok(cmds.has(cmd), `docs/${f}: documents \`iris ${cmd}\` which is not a real CLI command`);
      }
    }
  }
});
