// @iris/channel-web browser shell — a STATIC asset (NOT typechecked, NOT in the
// test glob; browser render is a manual smoke). It MIRRORS @iris/client-sdk's wire
// logic (no bundler → no shared import) and talks the `iris serve` two-identifier
// protocol over SSE. It persists {sessionId, continuationToken} to localStorage so a
// tab close/reload resumes the SAME session WHILE THE SERVER IS UP (the channel owns
// the token in its in-memory Map; a serve RESTART does NOT resume via the REST token
// — that cross-restart/host-migration durability is the edge deploy's story). On a
// stale token (404/409, e.g. after a restart) the shell starts fresh, never throws.
const KEY = "iris.session";
const $ = (id) => document.getElementById(id);

function loadHandle() {
  try {
    const h = JSON.parse(localStorage.getItem(KEY) || "null");
    return h && typeof h.sessionId === "string" && typeof h.continuationToken === "string" ? h : null;
  } catch {
    return null;
  }
}
function saveHandle(h) { try { localStorage.setItem(KEY, JSON.stringify(h)); } catch {} }
function clearHandle() { try { localStorage.removeItem(KEY); } catch {} }

let handle = loadHandle();

function append(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = (role === "user" ? "you> " : "agent> ") + text;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
  return div;
}
function banner(t) { $("banner").textContent = t; }

banner(handle
  ? "resumed session " + handle.sessionId + " (close/reload keeps it while the server is up)"
  : "new session");

// Mirror of client-sdk parseSseFrames: complete frames out, trailing partial in rest.
function parseSse(buf) {
  const events = [];
  let rest = buf;
  let i = rest.indexOf("\n\n");
  while (i !== -1) {
    const frame = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) { try { events.push(JSON.parse(data)); } catch { events.push({ type: "error", message: "malformed SSE data frame" }); } }
    i = rest.indexOf("\n\n");
  }
  return { events, rest };
}

async function turn(text) {
  append("user", text);
  const url = handle ? "/v1/session/" + encodeURIComponent(handle.sessionId) + "/message" : "/v1/session";
  const body = { messages: [{ role: "user", content: text }] };
  if (handle) body.continuationToken = handle.continuationToken;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    if (res.status === 404 || res.status === 409) { clearHandle(); handle = null; banner("previous session expired — starting fresh"); }
    append("agent", "⚠ " + msg);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let line = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    const parsed = parseSse(buf);
    buf = parsed.rest;
    for (const ev of parsed.events) {
      if (ev.type === "delta") {
        if (!line) line = append("agent", "");
        line.textContent += ev.text;
        $("log").scrollTop = $("log").scrollHeight;
      } else if (ev.type === "error") {
        append("agent", "⚠ " + ev.message);
      } else if (ev.type === "outcome") {
        if (ev.continuationToken) { handle = { sessionId: ev.sessionId, continuationToken: ev.continuationToken }; saveHandle(handle); }
        if (!line && ev.status === "finished" && ev.output !== undefined) append("agent", JSON.stringify(ev.output));
      }
    }
    if (done) break;
  }
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("input").value.trim();
  if (!v) return;
  $("input").value = "";
  turn(v).catch((err) => append("agent", "⚠ " + (err && err.message ? err.message : String(err))));
});
$("reset").addEventListener("click", () => { clearHandle(); handle = null; $("log").innerHTML = ""; banner("new session"); });
