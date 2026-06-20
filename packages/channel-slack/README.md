# @irisrun/channel-slack

**Own, portable, verifiable state — where a buyer feels it.** A first-party Slack
channel built on the [channel port](../channel-core) to demonstrate the one thing
only Iris does: a Slack approval that **pauses for hours, survives a redeploy, and
resumes the same session byte-identically.**

## What it is

`makeSlackChannel({ session, inbox, signingSecret, ... }).handleEvent(headers, rawBody)`:

1. **Verifies** the Slack signature first (HMAC-SHA256, constant-time, 5-minute replay
   window) — an unverified body is never processed.
2. Handles the `url_verification` handshake.
3. A **slash command** starts a durable session. If the agent parks on a
   human-in-the-loop approval, the channel posts **Approve / Deny** buttons whose
   `value` carries the approval context `{sessionId, callId, name}`.
4. An **Approve/Deny** interaction submits the governed decision to the `@irisrun/auth`
   inbox and **resumes** the session.

## Why it survives a redeploy

The durable session lives in the `StateStore` journal (the parked `signal_recv` is
journaled). The approval *context* rides the **signed Slack button value**, not server
memory; the `Principal` comes from the click's authenticated user. So a fresh instance
with an empty in-memory map still resumes: verify → read the button value →
`inbox.submit` → resume the session the store already holds. This is proven in-env
against a real store across a simulated redeploy
(`tests/channel-slack-durable.test.ts`); a real Slack workspace is the operator step.

Zero runtime deps: `node:crypto` for verification, built-in `fetch` for outbound
(injectable for tests). It passes the shared channel-port conformance suite.

---

Part of Iris — own, portable, verifiable state.
