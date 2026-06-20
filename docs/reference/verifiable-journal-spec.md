# The Iris verifiable-journal export format (v1)

> Status: stable. Format `iris-journal-export`, version `1`, algorithm
> `sha256/iris-journal-v1`. Reproducible in any language from this document
> alone. See also the [threat model](./threat-model.md) and the
> [funnel chapter](../verifiable-journal.md).

An Iris session is an event-sourced journal: every nondeterministic input (the
model call, tool calls, the clock) is recorded as an effect, and replay reads the
recorded result instead of re-invoking it. A **verifiable journal export** packages
that journal into a single, self-contained, content-addressed file that a third
party can move between hosts and verify independently.

## 1. The file

Canonical JSON (UTF-8, object keys sorted recursively — the same canonical form
the records themselves use). Suggested on-disk name: `<contentDigest>.irisjournal`.

```jsonc
{
  "format": "iris-journal-export",
  "version": 1,
  "algorithm": "sha256/iris-journal-v1",
  "sessionId": "…",
  "defDigest": "…",          // governing image digest of the last included record; "" if 0 records
  "complete": false,          // see §3
  "range": { "from": 23, "to": 23 } | null,   // seq range of included records; null if none
  "snapshot": {               // present iff the export starts from a snapshot
    "upToSeq": 22,
    "bytesB64": "…",          // base64 of the stored snapshot-state bytes (canonical JSON)
    "hash": "…"               // sha256(snapshotBytes) — diagnostic
  } | null,
  "records": [
    { "seq": 23, "bytesB64": "…", "hash": "…" }   // bytesB64 = the EXACT stored record bytes
  ],
  "chainHash": "…",           // tamper-evident over genesis + record order/content
  "contentDigest": "…"        // THE content address (sha256 over the addressing preimage)
}
```

`bytesB64` for each record and the snapshot is the base64 of the **exact bytes the
store holds** (canonical JSON). They are never re-serialized on export or import —
a faithful, byte-preserving copy is what makes the content address meaningful.

## 2. Hash construction (normative)

All hashes are lowercase-hex SHA-256, a fixed-width 64-character string.
`sha256(x)` hashes the UTF-8 bytes of a string `x` or the raw bytes of a byte
array. `canonicalize(v)` is deterministic JSON with object keys sorted recursively
(arrays keep order; numbers via standard JSON; it rejects non-finite numbers).

1. **Per-record / snapshot hash (diagnostic):**
   `record.hash = sha256(recordBytes)`, `snapshot.hash = sha256(snapshotBytes)`,
   where the bytes are the base64-decode of `bytesB64`.

2. **Genesis** (a canonical-JSON preimage — *not* string concatenation, so a
   `sessionId`/`defDigest` containing any character is unambiguous):

   ```
   genesis = sha256(canonicalize({
     "v": "iris-journal-v1",
     "sessionId": <sessionId>,
     "defDigest": <defDigest>,
     "snapshot": <snapshot ? {"upToSeq": …, "hash": …} : null>
   }))
   ```

3. **Chain** (order- and content-sensitive; both operands are fixed-width hex, so
   plain concatenation is injective):

   ```
   chain[0]   = genesis
   chain[i+1] = sha256(chain[i] + record.hash[i])     // records in ascending seq
   chainHash  = chain[n]                               // = genesis when n = 0
   ```

4. **Content address** (the single name over the whole export):

   ```
   contentDigest = sha256(canonicalize({
     "algorithm":   "sha256/iris-journal-v1",
     "chainHash":   <chainHash>,
     "complete":    <complete>,
     "defDigest":   <defDigest>,
     "format":      "iris-journal-export",
     "range":       <range>,
     "recordCount": <records.length>,        // DERIVED, recomputed on verify
     "sessionId":   <sessionId>,
     "snapshot":    <snapshot ? {"hash": …, "upToSeq": …} : null>,
     "version":     1
   }))
   ```

Verification is **authoritative on the recompute** from the actual `bytesB64`,
never on the stored `hash`/`recordCount` copies. Editing a record's bytes, the
stored per-record hash, the order, `recordCount`, or any addressing field changes
the recomputed `contentDigest`.

### Portability constraints

- Every number in a canonicalized preimage (`range.from`/`to`, `upToSeq`,
  `version`, `recordCount`) is a small non-negative **integer** — no floats or
  exponents — so number formatting cannot diverge across languages.
- `canonicalize` sorts keys, so the field *order* written above is irrelevant to
  the digest; a second implementer need only match the key *set* and the integer
  values.

## 3. The `complete` flag

`complete` mirrors how Iris's own offline verifier scopes a session: it is `true`
iff the export carries full history from sequence 0 (no truncation gap).

```
complete = fullJournal.length === 0 ? (snapshot === null) : (fullJournal[0].seq === 0)
```

A snapshot-only export, or one whose tail begins after a truncation, is
`complete: false`. In that case an effect-result whose intent was truncated away is
a legitimate "orphan" and is **not** treated as an error.

`complete` is a producer attestation: a falsely `complete: true` truncated window is
*caught* (its orphan results and range-start fail verification), but a full-history
journal re-labelled `complete: false` only *relaxes* the orphan check and is not, by
itself, detectable — consistent with the [threat model](./threat-model.md): the
content address proves these exact bytes, not their provenance.

## 4. Verification — two tiers

**Tier 1 — file only (zero dependencies, no store, no image).** This is the
"anyone can run" guarantee.

1. Parse the file; check `format`/`version`/`algorithm`.
2. Recompute every record/snapshot hash, the `chainHash`, `recordCount`, and the
   `contentDigest` from the raw `bytesB64`; compare to the embedded values.
3. **Canonical-bytes check:** for each record and the snapshot, assert
   `canonicalize(parse(bytes))` is byte-equal to `bytes` (catches a foreign or
   tampered payload that is non-canonical or contains a non-finite number).
4. Structural integrity: dense, monotonic sequence numbers; ≤1 result per effect;
   and — only when `complete` — every result joins a prior intent. The `range`
   must match the records, and a `complete` export must start at the expected seq.

Verification **never throws** on a malformed file — it returns a result with named
issues and a non-zero exit code.

**Tier 2 — replay-determinism (needs the reducer).** Given the program reducer
(for Iris harness sessions, rebuilt from core with interactivity auto-detected from
the journal — the image is *not* needed for the reducer), replay the journal and
confirm it folds deterministically and totally, yielding a final-state digest. The
optional `--image` pin only asserts the file's `defDigest` matches that image's
`lock.imageDigest`; it does not supply the reducer.

## 5. CLI

```sh
iris journal export <session> --store <db> --out <file>
iris journal verify <file> [--replay] [--image <layoutdir>] [--json]
iris journal import --in <file> --store <db>
```

`iris journal verify` exits 0 iff the export is valid (so it drops into CI).
`iris journal import` refuses a non-empty destination before writing anything.

---

Read next: **[the threat model](./threat-model.md)** — what this does and does not
prove. Back to the **[funnel](../verifiable-journal.md)**.
