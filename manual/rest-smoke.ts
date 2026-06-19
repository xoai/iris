// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_REST_SMOKE=1 node manual/rest-smoke.ts
//
// Proves the @iris/channel-rest two-identifier protocol (ADR-0009) over a REAL
// external HTTP socket (the install-free suite uses 127.0.0.1; here we bind a
// reachable port). It exercises the round-trip the in-process test cannot fully
// stand in for: a real client over the network presenting the issued
// continuationToken, the channel rotating it, and a stale token getting a loud 4xx.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessProgram, defaultBundle } from "@iris/core";
import { FsStateStore, FsScheduler } from "@iris/store-fs";
import { makeRestChannel } from "@iris/channel-rest";

const INPUT = { messages: [{ role: "user", content: "go" }] };

// a trivial finishing program (no effects) — the protocol is the subject, not the agent
const program = {
  initial: { turns: 0 },
  reducer: (s, rec) => (rec.kind === "marker" && rec.payload && rec.payload.marker === "finish" ? { turns: s.turns + 1 } : s),
  step: (s) => ({ type: "finish", output: { turn: s.turns } }),
};

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function main() {
  if (process.env.IRIS_REST_SMOKE !== "1") {
    console.log("skip: set IRIS_REST_SMOKE=1 to run the real external HTTP REST smoke");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "iris-rest-smoke-"));
  const adapter = { name: "serverless-fs", capabilities: { long_running: false, filesystem: true }, store: new FsStateStore({ root }), scheduler: new FsScheduler({ root }) };
  const channel = makeRestChannel({
    adapter,
    makeTurnInputs: () => ({ program, performers: {}, clock: { now: () => 1 }, defDigest: "img" }),
  });
  // bind a reachable port (PORT env or 8787) on ALL interfaces (0.0.0.0) so a real
  // external client can reach it; the smoke's own client connects via loopback.
  const port = Number(process.env.PORT ?? 8787);
  const base = await channel.listen(port, "0.0.0.0");
  try {
    const start = await post(`${base}/v1/session`, {});
    assert.equal(start.status, 200);
    assert.equal(typeof start.json.continuationToken, "string");
    const sid = start.json.sessionId, t1 = start.json.continuationToken;

    const cont = await post(`${base}/v1/session/${sid}/message`, { continuationToken: t1 });
    assert.equal(cont.status, 200);
    const t2 = cont.json.continuationToken;
    assert.notEqual(t2, t1, "token must rotate");

    const stale = await post(`${base}/v1/session/${sid}/message`, { continuationToken: t1 });
    assert.equal(stale.status, 409, "a stale token must be refused with a loud 4xx");

    console.log(`rest-smoke PASS — real HTTP at ${base}: issued → rotated → stale-rejected`);
  } finally {
    await channel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("rest-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
