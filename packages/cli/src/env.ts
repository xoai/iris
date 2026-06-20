// Host-side env/secrets resolution for the iris CLI runtime (initiative
// 20260620-agentfile-env-secrets). LEAST-PRIVILEGE: a subprocess tool receives
// ONLY the Agentfile-declared env (resolved `secrets` values + `environment`
// literals) plus a fixed, non-secret connectivity base — never the operator's full
// process.env, and never an undeclared host var. Values are supplied at run time
// via --env-file / --env; secret VALUES never enter the manifest/image/journal and
// are NEVER echoed in an error message. Zero deps; pure + injected-input so the
// whole resolution is unit-testable without a process/fs/platform. Host-side.
import { join } from "node:path";
import { isEnvName } from "@irisrun/agent";

export type EnvMap = Record<string, string>;

// The fixed connectivity/runtime base pulled from `hostEnv` — the ONLY host
// passthrough in scoped mode (these are config, not secrets). Including the
// proxy/TLS vars prevents the "declaring one `environment` default silently breaks
// a proxied tool" cliff. Deliberately EXCLUDES SHELL/USER/LOGNAME/PWD/arbitrary
// host vars (least-privilege — a tool that needs one must declare it).
const POSIX_BASE = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];
const WIN32_BASE = [
  "SystemRoot", "windir", "SystemDrive", "Path", "PATHEXT", "TEMP", "TMP",
  "COMSPEC", "NUMBER_OF_PROCESSORS", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
];

/**
 * The fixed, non-secret base env a subprocess tool gets in scoped mode. Pure +
 * platform-injected so both branches are testable on any host. On win32, env names
 * are case-INSENSITIVE (`Path` vs `PATH`) — match case-insensitively but preserve
 * the host's actual key spelling.
 */
export function baseEnv(platform: string, hostEnv: EnvMap): EnvMap {
  const out: EnvMap = {};
  if (platform === "win32") {
    const byLower = new Map<string, string>(); // lowercased name → actual host key
    for (const k of Object.keys(hostEnv)) byLower.set(k.toLowerCase(), k);
    for (const want of WIN32_BASE) {
      const actual = byLower.get(want.toLowerCase());
      if (actual !== undefined) out[actual] = hostEnv[actual];
    }
  } else {
    for (const k of POSIX_BASE) {
      if (hostEnv[k] !== undefined) out[k] = hostEnv[k];
    }
  }
  return out;
}

/**
 * Parse a dotenv-subset env file. Lines: blank / `# comment` / `KEY=VALUE`
 * (optional `export ` prefix; spaces around the first `=` tolerated). Split on the
 * FIRST `=` (so `=` in a value is preserved). `KEY=` is an explicit empty value. A
 * value WHOLLY wrapped in one matching pair of `'…'`/`"…"` has that one outer pair
 * stripped and the inner text taken BYTE-LITERAL (no escapes, no `${}`). A `#` after
 * unquoted whitespace begins a trailing comment; a `#` inside a quoted value is
 * literal. There is NO bare-`KEY` host-passthrough form — a line without `=` is a
 * loud error (a bare KEY would let a file reach into process.env for an undeclared
 * name). Errors name source + line + KEY, NEVER the value.
 */
export function parseEnvFile(text: string, source: string): EnvMap {
  const out: EnvMap = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    if (line.endsWith("\r")) line = line.slice(0, -1); // CRLF tolerance
    const lstripped = line.replace(/^\s+/, "");
    if (lstripped === "" || lstripped.startsWith("#")) continue;
    let body = lstripped;
    if (body.startsWith("export ")) body = body.slice("export ".length).replace(/^\s+/, "");
    const eq = body.indexOf("=");
    if (eq < 0) {
      throw new Error(`env file ${source}: line ${lineNo}: expected KEY=VALUE (a line without "=" is not allowed)`);
    }
    const key = body.slice(0, eq).trim();
    if (!isEnvName(key)) {
      throw new Error(`env file ${source}: line ${lineNo}: "${key}" is not a valid env-var name`);
    }
    out[key] = parseEnvValue(body.slice(eq + 1));
  }
  return out;
}

// Extract a value: if wholly wrapped in one matching quote pair, strip that pair
// (inner byte-literal); otherwise trim leading whitespace, cut a trailing
// ` # comment` (a `#` preceded by whitespace), and trim the tail.
function parseEnvValue(raw: string): string {
  const s = raw.replace(/^\s+/, "");
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end >= 1) {
      const after = s.slice(end + 1).replace(/^\s+/, "");
      if (after === "" || after.startsWith("#")) return s.slice(1, end); // byte-literal inner
    }
  }
  return stripTrailingComment(s).trimEnd();
}

// Cut a trailing ` # comment` — a `#` that is preceded by whitespace (so `KEY=#x`
// keeps `#x`, but `KEY=v # c` keeps `v`).
function stripTrailingComment(s: string): string {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "#" && /\s/.test(s[i - 1])) return s.slice(0, i);
  }
  return s;
}

/**
 * Parse `--env KEY=VALUE` args. Split on the FIRST `=` (so `=` in a value is
 * preserved); `KEY=` is an explicit empty value; a missing `=` or a bad key is a
 * loud error (value never echoed). Built in order so a later `--env` wins.
 */
export function parseInlineEnv(pairs: string[], source = "--env"): EnvMap {
  const out: EnvMap = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      throw new Error(`${source}: "${pair}" must be KEY=VALUE (missing "=")`);
    }
    const key = pair.slice(0, eq).trim();
    if (!isEnvName(key)) {
      throw new Error(`${source}: "${key}" is not a valid env-var name`);
    }
    out[key] = pair.slice(eq + 1); // byte-literal (the shell already handled quoting)
  }
  return out;
}

export interface ResolveToolEnvInput {
  secrets?: string[];
  environment?: EnvMap;
  base: EnvMap; // baseEnv(platform, hostEnv)
  hostEnv: EnvMap;
  fileEnv: EnvMap; // merged --env-file (later file already won)
  inlineEnv: EnvMap; // merged --env (later flag already won)
}

export interface ResolveToolEnvResult {
  env: EnvMap;
  missing: string[]; // declared secrets with no value (caller refuses to run)
}

/**
 * Resolve the env a subprocess tool should receive. SCOPED (least-privilege) when
 * the image declares `secrets`/`environment` — the allowed key set is exactly
 * `secrets ∪ keys(environment)`; `hostEnv` is consulted ONLY by the per-secret-name
 * lookup (never bulk-overlaid), and an undeclared `--env`/`--env-file` key throws.
 * LEGACY (no declaration) — full inherit + overlay (backward-compatible).
 *
 * Precedence — secret NAME: inline > file > host(non-"") else missing.
 *              environment KEY: inline > file > literal (host NOT consulted).
 */
export function resolveToolEnv(input: ResolveToolEnvInput): ResolveToolEnvResult {
  const { secrets, environment, base, hostEnv, fileEnv, inlineEnv } = input;
  const scoped = secrets !== undefined || environment !== undefined;
  if (!scoped) {
    return { env: { ...hostEnv, ...fileEnv, ...inlineEnv }, missing: [] };
  }

  const secretNames = secrets ?? [];
  const envLiterals = environment ?? {};
  const declared = new Set<string>([...secretNames, ...Object.keys(envLiterals)]);

  // Least-privilege: an undeclared runtime key cannot reach a tool.
  for (const k of [...Object.keys(fileEnv), ...Object.keys(inlineEnv)]) {
    if (!declared.has(k)) {
      throw new Error(
        `"${k}" is not declared in the Agentfile's secrets/environment — declare it or it will not be passed to tools`,
      );
    }
  }

  const env: EnvMap = { ...base };
  // environment KEYs: inline > file > literal default (host NOT consulted).
  for (const [key, literal] of Object.entries(envLiterals)) {
    env[key] = key in inlineEnv ? inlineEnv[key] : key in fileEnv ? fileEnv[key] : literal;
  }
  // secret NAMEs: inline > file > host(non-"") else missing.
  const missing: string[] = [];
  for (const name of secretNames) {
    if (name in inlineEnv) env[name] = inlineEnv[name];
    else if (name in fileEnv) env[name] = fileEnv[name];
    else if (hostEnv[name] !== undefined && hostEnv[name] !== "") env[name] = hostEnv[name];
    else missing.push(name);
  }
  return { env, missing };
}

export interface ResolveToolEnvForImageInput {
  secrets?: string[];
  environment?: EnvMap;
  platform: string;
  hostEnv: EnvMap;
  envFiles: Array<{ source: string; text: string }>; // already-read contents (argv order)
  envInline: string[]; // raw `--env` KEY=VAL strings (argv order)
  command?: string; // error prefix, e.g. "iris run"
  onWarn?: (message: string) => void; // non-fatal advisories (e.g. argv-exposed secret)
}

/**
 * The single TESTED seam the run/chat/serve wiring calls: parse files + inline,
 * resolve, and THROW the loud missing-secret / undeclared-key errors (never echoing
 * a value). The cli-main argv/fs glue stays manual-smoke. Returns the scoped env for
 * `makeSubprocessTransport(specs, { env })`, or `undefined` in legacy mode with no
 * runtime env at all (so the transport inherits process.env, byte-identical).
 */
export function resolveToolEnvForImage(input: ResolveToolEnvForImageInput): EnvMap | undefined {
  const cmd = input.command ?? "iris";
  const fileEnv: EnvMap = {};
  for (const f of input.envFiles) Object.assign(fileEnv, parseEnvFile(f.text, f.source));
  let inlineEnv: EnvMap;
  try {
    inlineEnv = parseInlineEnv(input.envInline);
  } catch (e) {
    throw new Error(`${cmd}: ${(e as Error).message}`);
  }

  // Hardening: a DECLARED secret passed via inline `--env` has its VALUE in argv
  // (visible in the process list / shell history / /proc/cmdline). Warn — steer
  // secrets to `--env-file`. Non-fatal; the value still resolves.
  if (input.onWarn && input.secrets) {
    for (const name of input.secrets) {
      if (Object.prototype.hasOwnProperty.call(inlineEnv, name)) {
        input.onWarn(
          `${cmd}: secret "${name}" passed via --env exposes its value in the process list / shell history — prefer --env-file`,
        );
      }
    }
  }

  const scoped = input.secrets !== undefined || input.environment !== undefined;
  // Legacy mode with NO runtime env → return undefined so the transport keeps the
  // current inherit-process.env behavior byte-identically.
  if (!scoped && input.envFiles.length === 0 && input.envInline.length === 0) {
    return undefined;
  }

  const base = baseEnv(input.platform, input.hostEnv);
  let result: ResolveToolEnvResult;
  try {
    result = resolveToolEnv({
      secrets: input.secrets,
      environment: input.environment,
      base,
      hostEnv: input.hostEnv,
      fileEnv,
      inlineEnv,
    });
  } catch (e) {
    throw new Error(`${cmd}: ${(e as Error).message}`);
  }
  if (result.missing.length > 0) {
    throw new Error(
      `${cmd}: required secret(s) not provided: ${result.missing.join(", ")} — supply via --env, --env-file <file>, or the host environment`,
    );
  }
  return result.env;
}

export interface SecretFileEnvResult {
  env: EnvMap; // the secret VALUES removed; `<NAME>_FILE` refs added
  files: Array<{ name: string; path: string; value: string }>; // for the caller to write 0600
}

/**
 * File-mount secrets (Docker "Very Low" tier — opt-in `--secret-files`). For each
 * declared secret NAME present in `env`, REMOVE its value from the env and instead
 * expose `<NAME>_FILE=<dir>/<NAME>`; the value is returned in `files[]` for the caller
 * to write to a 0600 file. The secret VALUE therefore NEVER enters the tool's
 * environment (the `*_FILE` convention apps already use for `/run/secrets/*`).
 * `environment` literals and the connectivity base stay as env vars (they are
 * non-secret). Pure — the fs writes are the caller's (bin) job. `name` is a validated
 * env-name (no path separators / `..`), so `join(dir, name)` cannot escape `dir`.
 */
export function secretFileEnv(env: EnvMap, secretNames: string[], dir: string): SecretFileEnvResult {
  const out: EnvMap = { ...env };
  const files: Array<{ name: string; path: string; value: string }> = [];
  for (const name of secretNames) {
    // Defensive: a secret NAME becomes a filesystem write path here (`join(dir,
    // name)`), so re-validate it is an env-name (no separators / `..`) rather than
    // trusting an upstream invariant this function can't see — `iris run` reads an
    // OCI layout WITHOUT re-validating it, so a hand-crafted `secrets` entry must
    // not be able to escape `dir`.
    if (!isEnvName(name)) {
      throw new Error(`secretFileEnv: invalid secret name ${JSON.stringify(name)} (not a valid env-var name)`);
    }
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      const fileKey = `${name}_FILE`;
      // A declared secret `TOKEN` would clobber a literal/secret already named
      // `TOKEN_FILE` — refuse loudly rather than silently overwrite.
      if (Object.prototype.hasOwnProperty.call(out, fileKey)) {
        throw new Error(`secretFileEnv: "${fileKey}" is already set — declared secret "${name}" collides with it under --secret-files`);
      }
      const value = out[name];
      delete out[name];
      const path = join(dir, name);
      out[fileKey] = path;
      files.push({ name, path, value });
    }
  }
  return { env: out, files };
}
