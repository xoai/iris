// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_SERVE_SMOKE=1 node manual/serve-streaming-smoke.ts
//
// Exercises the TURNKEY `iris serve` over a REAL sqlite-backed host on a reachable
// port: the buffered REST path, the SSE streaming path (records + model token
// deltas + a terminal outcome with a rotated continuationToken), and the
// hand-rolled WebSocket path (held connection, same event model). The model is the
// install-free echo by default; set ANTHROPIC_API_KEY + IRIS_SERVE_MODEL=anthropic
// for the real provider. Supersedes the old ws-channel-smoke (which assumed the
// `ws` npm package — now hand-rolled, zero-dep).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdBuild, cmdServe } from "@iris/cli";
import { echoStreamingPerformer } from "@iris/cli";
import { anthropicStreamingModelPerformer } from "@iris/provider-anthropic";
import { makeLocalResolver } from "@iris/agent";

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    out.push({ type, data: data ? JSON.parse(data) : {} });
  }
  return out;
}

async function main() {
  if (process.env.IRIS_SERVE_SMOKE !== "1") {
    console.log("skip: set IRIS_SERVE_SMOKE=1 to run the real serve + SSE + WS smoke");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "iris-serve-smoke-"));
  const layout = join(root, "image");
  await cmdInit(root);
  await cmdBuild({ file: join(root, "agent.json"), out: layout, resolver: makeLocalResolver({}) });

  const sqlite = await import("@iris/store-sqlite");
  const handle = sqlite.openDatabase(join(root, "serve.sqlite"));
  const store = new sqlite.SqliteStateStore(handle);
  const scheduler = new sqlite.SqliteScheduler(handle);

  const useAnthropic = process.env.IRIS_SERVE_MODEL === "anthropic" && process.env.ANTHROPIC_API_KEY;
  const makeModelPerformer = (model, onDelta) =>
    useAnthropic ? anthropicStreamingModelPerformer({ model, onDelta }) : echoStreamingPerformer(onDelta);

  const port = Number(process.env.PORT ?? 8799);
  const serve = await cmdServe(layout, {
    store,
    scheduler,
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer,
    port,
    host: "0.0.0.0",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    // --- buffered REST ----------------------------------------------------
    const buf = await fetch(`${base}/v1/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }).then((r) => r.json());
    assert.equal(buf.status, "finished");
    assert.equal(typeof buf.continuationToken, "string");

    // --- SSE streaming ----------------------------------------------------
    const sseRes = await fetch(`${base}/v1/session`, {
      method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: "{}",
    });
    const sse = parseSse(await sseRes.text());
    const oc = sse.find((e) => e.type === "outcome").data;
    assert.equal(oc.status, "finished");
    assert.ok(sse.some((e) => e.type === "record"), "SSE streamed journal records");
    const deltaText = sse.filter((e) => e.type === "delta").map((e) => e.data.text).join("");
    assert.ok(deltaText.length > 0, "SSE streamed model token deltas");
    // continue with the rotated token
    const sse2 = parseSse(
      await fetch(`${base}/v1/session/${oc.sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ continuationToken: oc.continuationToken }),
      }).then((r) => r.text()),
    );
    const oc2 = sse2.find((e) => e.type === "outcome").data;
    assert.equal(oc2.status, "finished");
    assert.notEqual(oc2.continuationToken, oc.continuationToken, "SSE rotated the token");

    // --- WebSocket --------------------------------------------------------
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    const frames = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
    await new Promise((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error("ws connection error")));
    });
    const waitOutcome = async () => {
      for (let i = 0; i < 400; i++) {
        const f = frames.find((x) => x.type === "outcome");
        if (f) return f;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("WS outcome timeout");
    };
    ws.send(JSON.stringify({}));
    const wsOc = await waitOutcome();
    assert.equal(wsOc.status, "finished");
    assert.ok(frames.some((f) => f.type === "record"), "WS streamed journal records");
    assert.ok(frames.some((f) => f.type === "delta"), "WS streamed model token deltas");
    frames.length = 0;
    ws.send(JSON.stringify({ continuationToken: wsOc.continuationToken }));
    const wsOc2 = await waitOutcome();
    assert.notEqual(wsOc2.continuationToken, wsOc.continuationToken, "WS rotated the token");
    ws.close();

    console.log(
      `serve-streaming-smoke PASS — real serve at ${base} (model=${useAnthropic ? "anthropic" : "echo"}): buffered + SSE + WS, tokens rotated`,
    );
  } finally {
    await serve.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("serve-streaming-smoke FAIL: " + (e && e.message ? e.message : e));
  process.exit(1);
});
