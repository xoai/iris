// @irisrun/channel-web — the web channel's HOST side (spec §2.2). `makeWebHandler`
// returns a pre-POST GET hook for `makeRestChannel`'s `webHandler` seam: it serves
// the two static assets (the chat page + its browser shell) and returns `false` for
// everything else, so `/v1/*` POST and the WebSocket upgrade are untouched. Host-side
// (node:fs to read the assets at load; node:http types only). The assets themselves
// are NOT typechecked / NOT in the test glob — the browser render is a manual smoke.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PACKAGE = "@irisrun/channel-web";

export interface WebAsset {
  contentType: string;
  body: string;
}

// Read an asset relative to THIS module (packages/channel-web/src/ → ../assets/).
function loadAsset(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The served routes: path → {contentType, body}. Loaded once at module init. */
export const webAssets: Record<string, WebAsset> = {
  "/": { contentType: "text/html; charset=utf-8", body: loadAsset("../assets/index.html") },
  "/iris-web.js": {
    contentType: "text/javascript; charset=utf-8",
    body: loadAsset("../assets/iris-web.js"),
  },
};

export interface WebHandlerOptions {
  /** reserved (future): a page title override. Unused today. */
  title?: string;
}

/**
 * A pre-POST GET hook for `RestChannelOptions.webHandler`. Serves `GET /` and
 * `GET /iris-web.js`; returns `false` for any other method/path so the REST channel
 * keeps handling `/v1/*` (and the upgrade listener keeps handling WS). Never throws.
 */
export function makeWebHandler(
  _opts: WebHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res): boolean => {
    if (req.method !== "GET") return false;
    const path = (req.url ?? "").split("?")[0];
    const asset = webAssets[path];
    if (asset === undefined) return false;
    res.writeHead(200, { "content-type": asset.contentType });
    res.end(asset.body);
    return true;
  };
}
