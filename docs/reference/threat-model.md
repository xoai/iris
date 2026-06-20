# Threat model — verifiable portable journals

> Companion to the [verifiable-journal spec](./verifiable-journal-spec.md). This
> document is deliberately precise about what content-addressing and replay
> verification **do** and **do not** prove. Saying this crisply is a credibility
> asset, not a hedge — it is the line a compliance reviewer probes first.

## Assets

- **The journal** — the recorded sequence of effects and results that *is* the
  session's execution.
- **The final-state claim** — the deterministic state a journal folds to on replay.
- **The content address** — the SHA-256 `contentDigest` that names a specific
  journal export.

## Trust boundaries

A journal export crosses three parties: the **producer** (who ran the session),
the **transport** (disk, network, registry, email — anywhere the file travels),
and the **verifier** (who checks it, possibly a stranger). The content address lets
the verifier trust the *bytes* independently of the transport: if they obtain the
expected `contentDigest` over a trusted channel (or compute it once and pin it),
any later copy is self-checking.

## What verification DETECTS

Tier-1 verification (file-only) catches every modification to a journal in transit,
because each breaks the recomputed `contentDigest`:

- a flipped/edited byte in any record or the snapshot;
- reordered, inserted, or deleted records (the hash chain is order-sensitive);
- a truncated tail or a desynced `recordCount`;
- a tampered snapshot;
- a forged stored per-record `hash` (verification recomputes from the bytes and
  ignores the stored copy);
- a non-canonical or non-finite record payload (the canonical-bytes check).

Tier-2 verification additionally proves the journal **folds deterministically and
totally** under the program reducer — i.e. it is a faithful, replayable record, not
a corrupt or non-deterministic one.

## What verification does NOT prove

This is the important half.

1. **Provenance / authorship.** Content-addressing proves *integrity* — "these are
   exactly the bytes named by this digest" — not *who produced them*. A party who
   controls the producer can write a *different but internally consistent* journal
   with a valid chain and a *different, valid* content address. Binding a journal to
   an author requires a **signature over the `contentDigest`** (out of scope for v1;
   see Future work).

2. **Truthfulness of recorded results.** Replay re-folds the *recorded* results; it
   **never re-executes** effects. A producer can journal a fabricated
   `effect_result` — a fake tool output, a fake model reply — and it will pass
   structural, content-address, **and** Tier-2 replay checks. Verification proves
   *the session replays to this state from these recorded results*, not *the results
   are what the real world/model/tool would have returned*. This is the most likely
   misreading of "verifiable" and is called out deliberately.

3. **Model determinism.** Replay reads the model's *captured* output; it does not
   make the model deterministic. Re-running the agent from scratch may yield a
   different model output. The guarantee is *record-replay fidelity*, not
   *reproducible inference*.

4. **Confidentiality.** The journal is cleartext (base64, not encrypted). Anyone who
   holds the file can read the conversation, tool arguments, and results.
   Content-addressing is integrity, not secrecy; encrypt the file at rest/in transit
   if its contents are sensitive.

## Residual risk and future work

- **Detached signatures** over the `contentDigest` would add provenance/authorship
  on top of integrity — the natural next layer, and the one a regulated buyer will
  ask for.
- **Encryption** of the export would add confidentiality where the journal carries
  sensitive data.
- **Result attestation** (e.g. signing tool/model outputs at the source) is the only
  thing that could raise (2) from "replays faithfully" toward "the recorded results
  are themselves trustworthy"; it is a producer-side concern outside this format.

---

Back to the **[spec](./verifiable-journal-spec.md)** · the
**[funnel chapter](../09-verifiable-journal.md)** · the sibling
**[sandbox-egress threat model](./security-sandbox-threat-model.md)** · the
**[project README](../../README.md)**.
