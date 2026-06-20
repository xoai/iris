// @irisrun/channel-web `makeWebHandler` (routes + content-type
// + false-fallthrough, never throws) AND the additive `channel-rest` webHandler seam
// (GET / is served while POST /v1/session still round-trips, proving the seam does
// not shadow the API). The browser shell render itself is an env-gated manual smoke.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Program, JournalRecord } from "@irisrun/core";
import { makeRestChannel, type TurnInputs } from "@irisrun/channel-rest";
import type { HostAdapter } from "@irisrun/host";
import { MemStateStore, MemScheduler, TestClock } from "./lib/mem-store.ts";
import { makeWebHandler, webAssets } from "@irisrun/channel-web";

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}
function fakeRes() {
  const cap = { status: 0, headers: {} as Record<string, string>, body: "", ended: false };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      cap.status = status;
      cap.headers = headers;
      return res;
    },
    end(body?: string) {
      if (body !== undefined) cap.body = body;
      cap.ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, cap };
}

test("makeWebHandler serves GET / as text/html and returns true", () => {
  const handler = makeWebHandler();
  const { res, cap } = fakeRes();
  assert.equal(handler(fakeReq("GET", "/"), res), true);
  assert.equal(cap.status, 200);
  assert.match(cap.headers["content-type"], /text\/html/);
  assert.ok(cap.body.includes("<!doctype html>") || cap.body.includes("<html"), "served the chat page");
});

test("makeWebHandler serves GET /iris-web.js as javascript and returns true", () => {
  const handler = makeWebHandler();
  const { res, cap } = fakeRes();
  assert.equal(handler(fakeReq("GET", "/iris-web.js"), res), true);
  assert.equal(cap.status, 200);
  assert.match(cap.headers["content-type"], /javascript/);
  assert.ok(cap.body.includes("parseSse"), "served the browser shell");
});

test("makeWebHandler honors a query string on a served path", () => {
  const handler = makeWebHandler();
  const { res, cap } = fakeRes();
  assert.equal(handler(fakeReq("GET", "/?x=1"), res), true);
  assert.equal(cap.status, 200);
});

test("makeWebHandler returns false (does not handle) for POST and unknown GET", () => {
  const handler = makeWebHandler();
  const a = fakeRes();
  assert.equal(handler(fakeReq("POST", "/"), a.res), false, "POST is not a web GET route");
  assert.equal(a.cap.ended, false, "did not touch the response");
  const b = fakeRes();
  assert.equal(handler(fakeReq("GET", "/v1/session"), b.res), false, "API paths fall through");
  const c = fakeRes();
  assert.equal(handler(fakeReq("GET", "/nope"), c.res), false, "unknown GET falls through");
});

test("webAssets exposes the two routes", () => {
  assert.deepEqual(Object.keys(webAssets).sort(), ["/", "/iris-web.js"]);
});

// --- the seam: GET / served, POST /v1/session still works --------------------

type ChState = { turns: number };
const program: Program<ChState> = {
  initial: { turns: 0 },
  reducer(state: ChState, record: JournalRecord): ChState {
    if (record.kind === "marker" && (record.payload as { marker?: string }).marker === "finish") {
      return { turns: state.turns + 1 };
    }
    return state;
  },
  step(state: ChState) {
    return { type: "finish", output: { turn: state.turns } } as const;
  },
};

test("seam: makeRestChannel with a webHandler serves GET / AND still POSTs /v1/session", async () => {
  const adapter: HostAdapter = {
    name: "iris-serve-test",
    capabilities: { long_running: true },
    store: new MemStateStore(),
    scheduler: new MemScheduler(),
  };
  const channel = makeRestChannel<ChState>({
    adapter,
    webHandler: makeWebHandler(),
    makeTurnInputs: (): TurnInputs<ChState> => ({
      program,
      performers: {},
      clock: new TestClock(1),
      defDigest: "img",
    }),
  });
  const base = await channel.listen();
  try {
    // GET / → the web page (the seam claimed it)
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    // POST /v1/session → still the API (the seam did NOT shadow it)
    const start = await fetch(`${base}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(start.status, 200);
    const json = (await start.json()) as { status: string; sessionId: string };
    assert.equal(json.status, "finished");
    assert.equal(typeof json.sessionId, "string");

    // an unknown GET still 404s through the normal handler (web handler returned false)
    const miss = await fetch(`${base}/nope`);
    assert.equal(miss.status, 405, "non-POST unknown path → the existing 405 guard");
  } finally {
    await channel.close();
  }
});
