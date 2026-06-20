// A ZERO-DEP YAML-SUBSET reader for AUTHORING Agentfiles (spec §3.2). Supports
// the doc's subset only: 2-space-indent maps, `- ` sequences, scalars (string /
// boolean / number), `#` comments. Anything outside the subset — flow (`{}`/`[]`),
// anchors/aliases (`&`/`*`), multi-document (`---`), tab indentation — is REJECTED
// LOUDLY (no silent misparse). The result is fed through validateAgentfile, so the
// authored format never affects the digest (the canonical surface is JSON). Host-side.
import type { Json } from "@irisrun/core";
import { validateAgentfile, type AgentfileModel } from "./agentfile.ts";

interface Line {
  indent: number;
  content: string;
  lineNo: number;
}

/** Parse a YAML-subset Agentfile into a validated model (throws loudly on bad/unsupported YAML). */
export function parseAgentfileYaml(text: string): AgentfileModel {
  return validateAgentfile(parseYamlValue(text));
}

/** Parse the YAML-subset into a plain JSON value (the raw, pre-validation tree). */
export function parseYamlValue(text: string): Json {
  const lines = lex(text);
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new Error(`Agentfile YAML: unexpected indentation at line ${lines[next].lineNo}`);
  }
  return value;
}

// Tokenize: strip comments + blank lines, reject unsupported constructs, record indent.
function lex(text: string): Line[] {
  const out: Line[] = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNo = i + 1;
    if (raw.trim() === "") continue;
    if (raw.trimStart().startsWith("#")) continue; // full-line comment
    if (raw.trimStart().startsWith("---") || raw.trimStart().startsWith("...")) {
      throw new Error(`Agentfile YAML: multi-document markers are unsupported (line ${lineNo})`);
    }
    const indentMatch = raw.match(/^[ \t]*/)![0];
    if (indentMatch.includes("\t")) {
      throw new Error(`Agentfile YAML: tab indentation is unsupported — use spaces (line ${lineNo})`);
    }
    const indent = indentMatch.length;
    const content = stripInlineComment(raw.slice(indent)).trimEnd();
    if (content === "") continue;
    out.push({ indent, content, lineNo });
  }
  return out;
}

// Strip a trailing ` # comment` — QUOTE-AWARE so a quoted value containing ` #`
// (e.g. `name: 'a #b'`) is never truncated, and `mcp://`/`subprocess://` values
// (no whitespace before `#`) are never affected. Cuts at the first `#` that is
// preceded by whitespace AND outside a quoted span.
function stripInlineComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && i > 0 && /\s/.test(s[i - 1])) {
      return s.slice(0, i);
    }
  }
  return s;
}

// Parse a block (map or sequence) at `indent`, starting at line `i`.
function parseBlock(lines: Line[], i: number, indent: number): [Json, number] {
  if (lines[i].content.startsWith("- ")) return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines: Line[], i: number, indent: number): [Json, number] {
  const obj: { [k: string]: Json } = {};
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.content.startsWith("- ")) {
      throw new Error(`Agentfile YAML: unexpected sequence item in a map (line ${line.lineNo})`);
    }
    const colon = line.content.indexOf(":");
    if (colon < 0) {
      throw new Error(`Agentfile YAML: expected "key: value" (line ${line.lineNo})`);
    }
    const key = line.content.slice(0, colon).trim();
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`Agentfile YAML: duplicate key "${key}" (line ${line.lineNo})`);
    }
    const rest = line.content.slice(colon + 1).trim();
    if (rest === "") {
      // a nested block on the following deeper-indented lines
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [child, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        obj[key] = child;
        i = next;
      } else {
        obj[key] = null; // empty block
        i++;
      }
    } else {
      obj[key] = parseScalar(rest, line.lineNo);
      i++;
    }
  }
  return [obj, i];
}

function parseSeq(lines: Line[], i: number, indent: number): [Json, number] {
  const arr: Json[] = [];
  while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("- ")) {
    const line = lines[i];
    const item = line.content.slice(2).trim();
    const colon = item.indexOf(":");
    if (colon > 0 && !looksScalar(item)) {
      // inline single-key map, e.g. "- ref: mcp://..."
      const key = item.slice(0, colon).trim();
      const val = item.slice(colon + 1).trim();
      arr.push({ [key]: parseScalar(val, line.lineNo) });
    } else {
      arr.push(parseScalar(item, line.lineNo));
    }
    i++;
  }
  return [arr, i];
}

// A bare scalar item in a sequence (no "key:" map shape). True when there is no
// top-level colon-space that would indicate an inline map.
function looksScalar(item: string): boolean {
  return !/^[A-Za-z0-9_.-]+:\s/.test(item) && !/^[A-Za-z0-9_.-]+:$/.test(item);
}

function parseScalar(s: string, lineNo: number): Json {
  if (s.startsWith("[") || s.startsWith("{")) {
    throw new Error(`Agentfile YAML: flow collections ([..]/{..}) are unsupported (line ${lineNo})`);
  }
  if (s.startsWith("&") || s.startsWith("*")) {
    throw new Error(`Agentfile YAML: anchors/aliases (&/*) are unsupported (line ${lineNo})`);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}
