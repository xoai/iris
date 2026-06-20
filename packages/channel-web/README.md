# @irisrun/channel-web

**Durable, resumable sessions a human can talk to in the browser.** A minimal,
zero-dependency web chat UI for `iris serve --web` that persists its session
handle to `localStorage`, so closing the tab or reloading the page resumes the
*same* durable session while the server is up.

## What it is

`makeWebHandler` is a host-side, pre-POST `GET` hook that serves two static assets
(`index.html` + `iris-web.js`) on the same port as the agent. The browser shell
speaks the `iris serve` SSE protocol and adopts the rotated `continuationToken`
the server returns, so resumption uses the same two-identifier discipline as every
other channel. The shell **mirrors** `@irisrun/client-sdk`'s wire logic (there is
no bundler, so it can't share the import); it is a static asset that lives
**outside** the TypeScript include and the test glob.

## Use it

```sh
iris serve ./image --port 8787 --web   # → open http://127.0.0.1:8787/
```

See **[docs/Channels](../../docs/channels.md)** for the serve protocol and
the client SDK.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
