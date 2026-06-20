# @irisrun/journal-export

**The portable journal you can verify from the file alone.** A self-contained,
content-addressed (SHA-256 + tamper-evident hash chain) export of a session's
snapshot + journal tail — carry it to any host, re-derive its content address,
and replay it byte-identically without trusting where it came from. This is the
host-side home of `node:crypto`, so `@irisrun/core` and `@irisrun/audit` stay
Node-free. Drives `iris journal`.

## What it is

`exportSession` reads a session's snapshot + tail from any `StateStore`;
`buildExport` assembles the `JournalExportV1` file model — base64 record/snapshot
bytes, a `chainHash` over genesis + record order, and the `contentDigest` that **is**
the content address (`<contentDigest>.irisjournal`). `verifyExport` runs two tiers
and **never throws**: Tier 1 (content-address + structure + canonical bytes) needs
only the file; Tier 2 (replay-determinism) additionally takes a caller-supplied
reducer — never one derived from an image. `recomputeFromExport` re-derives every
hash from the bytes, so the address is reproducible by anyone. `importSession`
writes the file into a fresh store on any host, identity preserved.

## Use it

```sh
iris journal export s1 --store s1.sqlite --out s1.irisjournal
iris journal verify s1.irisjournal --replay
iris journal import --in s1.irisjournal --store vps.sqlite
```

See **[docs/The verifiable journal](../../docs/verifiable-journal.md)**.

---
Part of [Iris](../../README.md) — own, portable, verifiable state.
