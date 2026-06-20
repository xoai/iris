# 09 — Verifiable portable journals

Chapter 08 showed that a session **is** its journal, and that `iris audit` can
replay-verify it. This chapter makes that guarantee **portable and externally
legible**: a session becomes a single self-contained file that anyone can move
between hosts and verify *without your store, your image, or even Iris itself*.

This is the proof behind the headline — *run anywhere, and prove it correct*.

## The artifact: a `*.irisjournal` file

`iris journal export` writes a session's snapshot + journal tail into one
canonical-JSON file that carries its own **SHA-256 content address** and a
tamper-evident hash chain:

```sh
iris journal export s1 --store s1.sqlite --out s1.irisjournal
```

```
exported session 's1': 24 records, complete=true
contentDigest 1c63f9eacb64d1c452fd6ac3e71aa0d01386a8114da878ead3dc160acc10500b
written s1.irisjournal
```

The `contentDigest` *names the bytes*: change anything — flip a byte, reorder a
record, drop one, edit the snapshot — and it no longer recomputes.

## Verify it — with nothing but the file

A third party who never saw your run can verify the file. **Tier 1** needs only
the file: zero dependencies, no store, no image.

```sh
iris journal verify s1.irisjournal
```

```
journal verify: OK
  session      s1
  content-addr OK (1c63f9eacb64d1c452fd6ac3e71aa0d01386a8114da878ead3dc160acc10500b)
  structure    OK (complete=true)
```

`iris journal verify` exits non-zero on any failure, so it drops straight into
CI. Add **`--replay`** for Tier 2 — it rebuilds the harness reducer and confirms
the journal folds deterministically and totally:

```sh
iris journal verify s1.irisjournal --replay
```

```
  replay       OK (deterministic=true, total=true; finalState 062fb1bc)
```

Pass `--image ./image` to additionally assert the file was produced under a
specific image pin, and `--json` for a machine-readable report.

## Move it to another host

`iris journal import` writes the file into a fresh store on any host — the same
session, now resumable there:

```sh
iris journal import --in s1.irisjournal --store vps.sqlite
```

Import refuses a non-empty destination, so it never clobbers an existing session.

## See it end to end

The bundled demo migrates one governed session **laptop (filesystem) → VPS
(SQLite) → edge (the Durable Objects code path)** as an `*.irisjournal` file,
resumes it byte-identically on the edge, and self-verifies at every hop —
install-free and deterministic:

```sh
npm run demo:cross-host
```

The laptop and VPS hops print the **same content digest** (the journal moved
unchanged), and the edge-resumed final state is **byte-identical to a single-host
control**. That is the one thing a session-state-on-one-vendor design cannot
reproduce.

## Go deeper

- **[The verifiable-journal spec](./reference/verifiable-journal-spec.md)** — the exact
  file format and the hash construction, reproducible in any language.
- **[The threat model](./reference/threat-model.md)** — precisely what verification proves,
  and (just as important) what it does *not*.

> **Precision (read this):** verification proves *faithful record-replay and
> tamper-evidence* — **not** that re-running the model yields the same output (the
> model is captured, not made deterministic), and content-addressing proves the
> integrity of *these bytes*, **not** their provenance. The threat model is
> explicit about both.

**Next → [Back to the funnel index](./README.md)**
