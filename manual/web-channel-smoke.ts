// MANUAL smoke — NOT in the unit suite, NOT typechecked (manual/ is outside the
// tsconfig include and the tests/**/*.test.ts runner glob).
//   IRIS_WEB_SMOKE=1 node manual/web-channel-smoke.ts
//
// Proves the `iris serve --web` web channel end-to-end at the PROTOCOL level (what
// the browser shell does): GET / serves the chat page, then a start + a resume with
// the stored handle continues the SAME session WHILE THE SERVER IS UP — the
// tab-close/reload durability (P0 item 4 / brief A4). The actual browser render
// (open http://127.0.0.1:8799 in a browser, chat, reload, watch it resume) is the
// human step this smoke stands in for. NOTE: a serve RESTART does NOT resume via the
// REST token (the channel's in-memory tokens Map is empty on a fresh channel) — that
// cross-restart/host-migration durability is the edge deploy's story (iris-deploy-smoke).
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdBuild, cmdServe, echoStreamingPerformer, loadBundledTools } from "iris-runtime";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    out.push({ type, data: data ? JSON.parse(data) : {} });
  }
  return out;
}

async function main() {
  if (process.env.IRIS_WEB_SMOKE !== "1") {
    console.log("skip: set IRIS_WEB_SMOKE=1 to run the web-channel smoke (serve --web + reload-resume)");
    return;
  }
  const src = await mkdtemp(join(tmpdir(), "iris-web-src-"));
  await cmdInit(src);
  const out = await mkdtemp(join(tmpdir(), "iris-web-out-"));
  const resolver = (await loadBundledTools(join(src, "tools"))).resolver;
  await cmdBuild({ file: join(src, "agent.json"), out, resolver });

  const serve = await cmdServe(out, {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer: (_model, onDelta) => echoStreamingPerformer(onDelta),
    port: 8799,
    web: true,
  });
  try {
    // 1) the page is served
    const page = await fetch(`${serve.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /iris — web chat/);
    assert.match((await (await fetch(`${serve.url}/iris-web.js`)).text()), /parseSse/);

    // 2) start a session (what the page does on first message)
    const r1 = parseSse(
      await (
        await fetch(`${serve.url}/v1/session`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
        })
      ).text(),
    );
    const oc1 = r1.find((e) => e.type === "outcome").data;
    assert.equal(oc1.status, "finished");
    const handle = { sessionId: oc1.sessionId, continuationToken: oc1.continuationToken };

    // 3) RELOAD: a fresh page using the stored handle resumes the SAME session (live server)
    const r2 = parseSse(
      await (
        await fetch(`${serve.url}/v1/session/${handle.sessionId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ continuationToken: handle.continuationToken, messages: [{ role: "user", content: "still here?" }] }),
        })
      ).text(),
    );
    const oc2 = r2.find((e) => e.type === "outcome").data;
    assert.equal(oc2.status, "finished");
    assert.equal(oc2.sessionId, handle.sessionId, "reload resumed the SAME session");
    assert.notEqual(oc2.continuationToken, handle.continuationToken, "token rotated on the resumed turn");

    console.log(`web-channel-smoke PASS — GET / served + reload resumed session ${handle.sessionId} (open ${serve.url} to try it live)`);
  } finally {
    await serve.close();
  }
}

main().catch((e) => {
  console.error("web-channel-smoke FAIL: " + (e && e.message ? e.message : e));
  process.exit(1);
});
