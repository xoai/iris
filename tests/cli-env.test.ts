// Env/secrets resolution unit tests (initiative 20260620-agentfile-env-secrets).
// All pure + injected-input — no process/fs/platform. Proves the least-privilege
// boundary, the dotenv parse rules, the total precedence, empty-value semantics,
// and that a secret VALUE never appears in an error message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  baseEnv,
  parseEnvFile,
  parseInlineEnv,
  resolveToolEnv,
  resolveToolEnvForImage,
  secretFileEnv,
} from "iris-runtime";

// --- baseEnv (both platforms, injected) --------------------------------------

test("env: baseEnv (POSIX) keeps connectivity vars, drops everything else", () => {
  const host = {
    PATH: "/usr/bin", HOME: "/home/x", HTTPS_PROXY: "http://p", LANG: "en_US.UTF-8",
    SHELL: "/bin/bash", USER: "x", GITHUB_TOKEN: "secret", AWS_SECRET: "leak",
  };
  const b = baseEnv("linux", host);
  assert.equal(b.PATH, "/usr/bin");
  assert.equal(b.HOME, "/home/x");
  assert.equal(b.HTTPS_PROXY, "http://p");
  assert.equal(b.LANG, "en_US.UTF-8");
  assert.ok(!("SHELL" in b) && !("USER" in b), "SHELL/USER deliberately excluded");
  assert.ok(!("GITHUB_TOKEN" in b) && !("AWS_SECRET" in b), "no host secrets in the base");
});

test("env: baseEnv (win32) matches case-insensitively and keeps host spelling", () => {
  const host = { Path: "C:\\bin", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\x", FOO: "x" };
  const b = baseEnv("win32", host);
  assert.equal(b.Path, "C:\\bin", "Path matched despite WIN32_BASE listing 'Path'");
  assert.equal(b.SystemRoot, "C:\\Windows");
  assert.equal(b.USERPROFILE, "C:\\Users\\x");
  assert.ok(!("FOO" in b), "undeclared host var excluded");
});

// --- parseEnvFile (dotenv subset) --------------------------------------------

test("env: parseEnvFile handles comments, export, spaces, first-=, quotes, KEY=", () => {
  const text = [
    "# a comment",
    "",
    "export GITHUB_TOKEN = ghp_abc",
    "JWT=a.b=c",                 // first-= split → value keeps the second =
    'QUOTED="a #b"',             // # inside quotes is literal
    "TRAILING=value # comment",  // trailing comment after whitespace
    "EMPTY=",
    "HASHVAL=#notacomment",      // # with no preceding whitespace stays
  ].join("\n");
  const m = parseEnvFile(text, "f.env");
  assert.equal(m.GITHUB_TOKEN, "ghp_abc");
  assert.equal(m.JWT, "a.b=c");
  assert.equal(m.QUOTED, "a #b");
  assert.equal(m.TRAILING, "value");
  assert.equal(m.EMPTY, "");
  assert.equal(m.HASHVAL, "#notacomment");
});

test("env: parseEnvFile rejects a bare KEY (no host pass-through side-door)", () => {
  assert.throws(() => parseEnvFile("GITHUB_TOKEN\n", "f.env"), /without "="|expected KEY=VALUE/i);
});

test("env: parseEnvFile error names source+line+KEY but NEVER the value", () => {
  try {
    parseEnvFile("1BAD=ghp_realsecret\n", "f.env");
    assert.fail("should have thrown");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /f\.env/);
    assert.match(msg, /1BAD/);
    assert.ok(!msg.includes("ghp_realsecret"), "the secret VALUE must not appear in the error");
  }
});

test("env: parseInlineEnv splits on first =, supports empty, rejects bad key", () => {
  const m = parseInlineEnv(["A=1", "B=x=y", "C="]);
  assert.deepEqual(m, { A: "1", B: "x=y", C: "" });
  assert.throws(() => parseInlineEnv(["NOEQ"]), /KEY=VALUE/i);
  assert.throws(() => parseInlineEnv(["1BAD=x"]), /valid env-var name/i);
});

// --- resolveToolEnv (the privilege boundary) ---------------------------------

const BASE = { PATH: "/usr/bin", HOME: "/home/x" };

test("env: scoped — secret resolves from host; env literal applies; nothing else leaks", () => {
  const r = resolveToolEnv({
    secrets: ["GITHUB_TOKEN"],
    environment: { LOG_LEVEL: "info" },
    base: BASE,
    hostEnv: { ...BASE, GITHUB_TOKEN: "ghp", OTHER_SECRET: "leak" },
    fileEnv: {},
    inlineEnv: {},
  });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.env, { PATH: "/usr/bin", HOME: "/home/x", LOG_LEVEL: "info", GITHUB_TOKEN: "ghp" });
  assert.ok(!("OTHER_SECRET" in r.env), "undeclared host secret never reaches the tool");
});

test("env: scoped — a stray host var does NOT override an environment literal", () => {
  const r = resolveToolEnv({
    environment: { LOG_LEVEL: "info" },
    base: BASE,
    hostEnv: { ...BASE, LOG_LEVEL: "debug" }, // host has a colliding name
    fileEnv: {},
    inlineEnv: {},
  });
  assert.equal(r.env.LOG_LEVEL, "info", "literal default wins over a stray host var (no bleed-through)");
});

test("env: scoped — precedence inline > file > host for a secret; inline > file > literal for env key", () => {
  const r = resolveToolEnv({
    secrets: ["TOKEN"],
    environment: { LOG_LEVEL: "info" },
    base: BASE,
    hostEnv: { ...BASE, TOKEN: "host" },
    fileEnv: { TOKEN: "file", LOG_LEVEL: "file-level" },
    inlineEnv: { TOKEN: "inline", LOG_LEVEL: "inline-level" },
  });
  assert.equal(r.env.TOKEN, "inline");
  assert.equal(r.env.LOG_LEVEL, "inline-level");
  const r2 = resolveToolEnv({
    secrets: ["TOKEN"], environment: { LOG_LEVEL: "info" }, base: BASE,
    hostEnv: { ...BASE, TOKEN: "host" }, fileEnv: { TOKEN: "file", LOG_LEVEL: "file-level" }, inlineEnv: {},
  });
  assert.equal(r2.env.TOKEN, "file");
  assert.equal(r2.env.LOG_LEVEL, "file-level");
});

test("env: scoped — a declared secret with no value is reported missing (host '' = absent)", () => {
  const r = resolveToolEnv({
    secrets: ["TOKEN"], base: BASE, hostEnv: { ...BASE, TOKEN: "" }, fileEnv: {}, inlineEnv: {},
  });
  assert.deepEqual(r.missing, ["TOKEN"], "host empty string counts as absent");
});

test("env: scoped — an explicit empty (--env TOKEN=) satisfies the secret", () => {
  const r = resolveToolEnv({
    secrets: ["TOKEN"], base: BASE, hostEnv: BASE, fileEnv: {}, inlineEnv: { TOKEN: "" },
  });
  assert.deepEqual(r.missing, []);
  assert.equal(r.env.TOKEN, "");
});

test("env: scoped — an undeclared --env/file key is REFUSED (least-privilege)", () => {
  assert.throws(
    () => resolveToolEnv({ secrets: ["TOKEN"], base: BASE, hostEnv: BASE, fileEnv: { ROGUE: "x" }, inlineEnv: {} }),
    /ROGUE.*not declared/i,
  );
});

test("env: legacy (no declaration) — full inherit + overlay, byte-compatible", () => {
  const r = resolveToolEnv({
    base: BASE, hostEnv: { PATH: "/usr/bin", FOO: "1", BAR: "2" }, fileEnv: { BAR: "3" }, inlineEnv: { BAZ: "4" },
  });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.env, { PATH: "/usr/bin", FOO: "1", BAR: "3", BAZ: "4" });
});

// --- resolveToolEnvForImage (the tested seam) --------------------------------

test("env: resolveToolEnvForImage — legacy + no flags returns undefined (transport inherits)", () => {
  const env = resolveToolEnvForImage({
    platform: "linux", hostEnv: { PATH: "/usr/bin" }, envFiles: [], envInline: [],
  });
  assert.equal(env, undefined, "no declaration + no flags → undefined → inherit process.env");
});

test("env: resolveToolEnvForImage — scoped resolves from a file", () => {
  const env = resolveToolEnvForImage({
    secrets: ["TOKEN"],
    environment: { LOG_LEVEL: "info" },
    platform: "linux",
    hostEnv: { PATH: "/usr/bin", HOME: "/home/x" },
    envFiles: [{ source: "f.env", text: "TOKEN=fromfile\n" }],
    envInline: [],
    command: "iris run",
  });
  assert.equal(env?.TOKEN, "fromfile");
  assert.equal(env?.LOG_LEVEL, "info");
  assert.equal(env?.PATH, "/usr/bin");
});

test("env: resolveToolEnvForImage — missing secret throws a NAMED error without the value", () => {
  assert.throws(
    () => resolveToolEnvForImage({
      secrets: ["TOKEN"], platform: "linux", hostEnv: {}, envFiles: [], envInline: [], command: "iris run",
    }),
    /iris run: required secret\(s\) not provided: TOKEN/,
  );
});

test("env: resolveToolEnvForImage — undeclared --env is refused", () => {
  assert.throws(
    () => resolveToolEnvForImage({
      secrets: ["TOKEN"], platform: "linux", hostEnv: { TOKEN: "x" },
      envFiles: [], envInline: ["ROGUE=1"], command: "iris run",
    }),
    /iris run: "ROGUE" is not declared/,
  );
});

test("env: resolveToolEnvForImage — warns when a declared secret is passed via --env (argv exposure)", () => {
  const warnings: string[] = [];
  resolveToolEnvForImage({
    secrets: ["TOKEN"], platform: "linux", hostEnv: {}, envFiles: [], envInline: ["TOKEN=x"],
    command: "iris run", onWarn: (m) => warnings.push(m),
  });
  assert.ok(
    warnings.some((w) => /TOKEN/.test(w) && /--env/.test(w) && /--env-file/.test(w)),
    `expected an argv-exposure warning; got ${JSON.stringify(warnings)}`,
  );
});

// --- secretFileEnv (file-mount secrets, Docker "Very Low" tier) ---------------

test("env: secretFileEnv moves secret VALUES out of env into files (value never in env)", () => {
  const { env, files } = secretFileEnv(
    { PATH: "/usr/bin", LOG_LEVEL: "info", GITHUB_TOKEN: "ghp", OPENAI_API_KEY: "sk" },
    ["GITHUB_TOKEN", "OPENAI_API_KEY"],
    "/run/iris-secrets",
  );
  assert.ok(!("GITHUB_TOKEN" in env) && !("OPENAI_API_KEY" in env), "secret VALUES removed from env");
  assert.equal(env.GITHUB_TOKEN_FILE, join("/run/iris-secrets", "GITHUB_TOKEN"));
  assert.equal(env.OPENAI_API_KEY_FILE, join("/run/iris-secrets", "OPENAI_API_KEY"));
  assert.equal(env.LOG_LEVEL, "info", "non-secret env stays as a var");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(files.length, 2);
  assert.equal(files.find((f) => f.name === "GITHUB_TOKEN")?.value, "ghp", "value carried for the caller to write");
});

test("env: secretFileEnv only touches declared secrets that are present", () => {
  const { env, files } = secretFileEnv({ PATH: "/usr/bin", TOKEN: "x" }, ["TOKEN", "ABSENT"], "/d");
  assert.equal(env.TOKEN_FILE, join("/d", "TOKEN"));
  assert.ok(!("ABSENT_FILE" in env), "a declared-but-absent secret yields no file ref");
  assert.equal(files.length, 1);
});

test("env: secretFileEnv defensively rejects a non-env-name (no path traversal via a tampered layout)", () => {
  assert.throws(() => secretFileEnv({ "../../etc/x": "v" } as Record<string, string>, ["../../etc/x"], "/d"), /invalid secret name/i);
});

test("env: secretFileEnv refuses to clobber a pre-existing <NAME>_FILE key", () => {
  assert.throws(
    () => secretFileEnv({ TOKEN: "x", TOKEN_FILE: "preset" }, ["TOKEN"], "/d"),
    /TOKEN_FILE.*already set|collides/i,
  );
});
