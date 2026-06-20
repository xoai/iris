// Docs-funnel integrity. Cheap regression guard so the guided path can't
// silently rot: every page exists, every relative link resolves, the "Next →"
// chain is correct, the index points at every page, and no page documents a CLI
// command that doesn't exist. Uses the boundary.test.ts ROOT pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(ROOT, "docs");

const PAGES = [
  "01-introduction.md",
  "02-first-agent.md",
  "03-tools.md",
  "04-channels.md",
  "05-deploy.md",
  "06-providers.md",
  "07-governance.md",
  "08-audit-and-evals.md",
  "09-verifiable-journal.md",
];
const ALL = ["README.md", ...PAGES];

test("docs-funnel: every funnel file exists", () => {
  for (const f of ALL) assert.ok(existsSync(join(DOCS, f)), `missing docs/${f}`);
});

test("docs-funnel: every relative markdown link resolves to a real file", () => {
  for (const f of ALL) {
    const text = readFileSync(join(DOCS, f), "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1];
      if (/^https?:/.test(raw) || raw.startsWith("#")) continue; // external / in-page anchor
      const target = raw.split("#")[0]; // strip any fragment
      if (target === "") continue;
      const resolved = resolve(DOCS, target);
      assert.ok(existsSync(resolved), `docs/${f}: broken relative link "${raw}" (→ ${resolved})`);
    }
  }
});

test("docs-funnel: numbered pages form a correct Next → chain", () => {
  for (let i = 0; i < PAGES.length; i++) {
    const text = readFileSync(join(DOCS, PAGES[i]), "utf8");
    const next = i < PAGES.length - 1 ? `./${PAGES[i + 1]}` : "./README.md";
    assert.match(text, /\*\*Next →/, `docs/${PAGES[i]} is missing a "Next →" marker`);
    assert.ok(text.includes(`(${next})`), `docs/${PAGES[i]} should link Next → ${next}`);
  }
});

test("docs-funnel: the index links to every page", () => {
  const idx = readFileSync(join(DOCS, "README.md"), "utf8");
  for (const p of PAGES) assert.ok(idx.includes(`(./${p})`), `index should link ./${p}`);
});

test("docs-funnel: every `iris <cmd>` in a code block is a real CLI command", () => {
  // valid commands = the cli-main.ts dispatcher's switch cases (source of truth)
  const cliMain = readFileSync(join(ROOT, "packages", "cli", "src", "cli-main.ts"), "utf8");
  const cmds = new Set([...cliMain.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]));
  assert.ok(
    cmds.has("init") && cmds.has("serve") && cmds.has("deploy"),
    "sanity: parsed the CLI command set from cli-main.ts",
  );
  // Only treat `iris <word>` as a CLI invocation when `iris` sits at a command
  // position — line start, or after a pipe / && / ; / `npx ` / an env-assignment
  // prefix. This avoids flagging an `iris …` phrase that happens to land in a
  // fenced block, while still catching a documented non-existent command.
  const invocation = /(?:^|\||&&|;|\bnpx\s+|\b[A-Z_]+=\S+\s+)\s*iris\s+([a-z][a-z-]*)/gm;
  for (const f of ALL) {
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

test("docs-funnel: the README points readers to the funnel", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /docs\/README\.md/, "README should link the docs funnel");
});
