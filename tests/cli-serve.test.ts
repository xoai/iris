// serve-streaming Task 6 (AS-6): `iris serve` end-to-end via cmdServe with an
// in-memory host + the echo streaming model (turnkey, no key). A streamed start
// yields deltas + records + a terminal outcome with a rotated token; a continue
// rotates again; and a plain BUFFERED POST works on the SAME server (the
// emit===undefined / no-stream branch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdBuild, cmdServe, echoStreamingPerformer, loadBundledTools, type ServeHandle } from "iris-runtime";
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

const tmp = (p: string): Promise<string> => mkdtemp(join(tmpdir(), p));

async function buildAndServe(web = false): Promise<ServeHandle> {
  const src = await tmp("iris-serve-src-");
  await cmdInit(src, { json: true });
  const out = await tmp("iris-serve-out-");
  // the scaffold ships a bundled tool → build with its discovered resolver
  const resolver = (await loadBundledTools(join(src, "tools"))).resolver;
  await cmdBuild({ file: join(src, "agent.json"), out, resolver });
  return cmdServe(out, {
    store: new MemoryStateStore(),
    scheduler: new MemoryScheduler(),
    capabilities: { long_running: true, filesystem: true, websockets: true },
    makeModelPerformer: (_model, onDelta) => echoStreamingPerformer(onDelta),
    port: 0,
    web,
  });
}

interface Frame {
  type: string;
  data: Record<string, unknown>;
}
function parseSse(text: string): Frame[] {
  const out: Frame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    out.push({ type, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} });
  }
  return out;
}

test("cmdServe: SSE start → stream a turn → continue with the rotated token (echo model, no key)", async () => {
  const serve = await buildAndServe();
  try {
    const res = await fetch(`${serve.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const oc = events.find((e) => e.type === "outcome")!.data;
    assert.equal(oc.status, "finished");
    assert.ok(events.some((e) => e.type === "record"), "record events streamed");
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.data.text as string).join("");
    assert.ok(deltas.length > 0, "the echo model streamed token deltas");
    assert.equal(typeof oc.continuationToken, "string");

    const res2 = await fetch(`${serve.url}/v1/session/${oc.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ continuationToken: oc.continuationToken }),
    });
    const oc2 = parseSse(await res2.text()).find((e) => e.type === "outcome")!.data;
    assert.equal(oc2.status, "finished");
    assert.notEqual(oc2.continuationToken, oc.continuationToken, "token rotated");
  } finally {
    await serve.close();
  }
});

test("cmdServe: a BUFFERED POST works on the same server (no Accept header → no stream)", async () => {
  const serve = await buildAndServe();
  try {
    const res = await fetch(`${serve.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const json = (await res.json()) as { status: string; sessionId: string; continuationToken: string };
    assert.equal(json.status, "finished");
    assert.equal(typeof json.continuationToken, "string");

    // and a buffered continue still rotates
    const res2 = await fetch(`${serve.url}/v1/session/${json.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuationToken: json.continuationToken }),
    });
    const json2 = (await res2.json()) as { status: string; continuationToken: string };
    assert.equal(json2.status, "finished");
    assert.notEqual(json2.continuationToken, json.continuationToken);
  } finally {
    await serve.close();
  }
});

test("cmdServe({web:true}): GET / serves the web chat UI; POST /v1/session still works (B3)", async () => {
  const serve = await buildAndServe(true);
  try {
    const page = await fetch(`${serve.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /iris — web chat/);

    // the API still works on the same port (the web seam did not shadow it)
    const start = await fetch(`${serve.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(start.status, 200);
    assert.equal(((await start.json()) as { status: string }).status, "finished");
  } finally {
    await serve.close();
  }
});
