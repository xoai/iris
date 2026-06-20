# Threat model — the sandbox egress firewall & credential broker

*Roadmap v0.2 P2 #8 — the adversarial review of the security spine before it is
load-bearing for real users. Companion to the sidecar egress proxy in
`@irisrun/sandbox` (`packages/sandbox/src/egress-proxy.ts`). Every guarantee
below maps to a test in `tests/sandbox-adversarial.test.ts` (plus the existing
`tests/sandbox-*.test.ts`).*

## Why this exists

`@irisrun/sandbox` is the security floor for untrusted tool code: a session
rooted at `/workspace` with a **deny-all** network default and **credential
brokering** so a secret is injected only at the egress boundary and never
materializes inside the sandbox. The README's headline — *"networking denied by
default; credentials brokered so secrets never enter the sandbox"* — is a
security claim, so it must be pressure-tested, not asserted.

The honest headline of this review: **the floor is fail-closed.** No probed
bypass vector reaches a denied host, and no probed exfil path surfaces a brokered
secret inside the sandbox. The one real defect found was a *consistency* gap
(HTTP and CONNECT normalized hostnames differently), now closed and pinned — see
Findings.

## Scope — this is the *sandbox egress* layer, not subprocess-tool env

This document covers the sandbox's **network-egress broker**, where an untrusted
tool *names* a secret and never holds it. It is a **separate layer** from host-side
**subprocess-tool env** (initiative 20260620-agentfile-env-secrets): a bundled
`subprocess://` tool runs host-side and legitimately receives its declared secrets
in its environment. That path is **least-privilege-scoped** — the tool gets ONLY the
Agentfile-declared `secrets`/`environment` plus a fixed non-secret base (PATH/HOME/
proxy/TLS), never the operator's whole shell, and an undeclared `--env`/`--env-file`
key is refused. Secret VALUES still never enter the manifest, image, journal, or any
error message — they are supplied at run time via `--env-file`/`--env`. See
[Tools → Secrets & environment](../03-tools.md) for the user-facing model.

## Assets

1. **Brokered secrets.** API keys / bearer tokens held host-side in the
   `CredentialBroker`. The invariant: the secret value reaches the *upstream
   request only*, never any sandbox-visible surface.
2. **The egress boundary.** The per-host allowlist that decides what may leave.
3. **Audit integrity.** The `egress[]` log of what actually left.

## Trust boundary

```
   UNTRUSTED                         │            TRUSTED (host-side)
   ─────────                         │            ──────────────────
   tool code in the sandbox          │   allowlist (networkAllows)
   • runs at /workspace              │   credential broker (secret store)
   • emits arbitrary HTTP / CONNECT  │   egress proxy (forward proxy)
   • crafts URLs, Host, x-iris-secret│   egress[] audit log
   • reads its own env/stdout/files  │
   • names a secret, never holds it ─┼──▶ broker injects at egress only
```

The adversary is the tool code. It can: choose any target host/port; send any
URL form (absolute, origin-form + `Host`, userinfo, IPv6, trailing-dot, mixed
case); name any secret via `x-iris-secret`; and inspect everything *it* can see
(env, stdout/stderr, `/workspace`). It cannot read host-side memory.

## Guarantees and their proofs

| # | Guarantee | Proof |
|---|-----------|-------|
| G1 | **Deny-all is the floor.** No network without an explicit policy. | `sandbox-inmemory.test.ts` (deny-all blocks a fetch, nothing egresses). |
| G2 | **Allowlist is exact-host, fail-closed.** A genuinely different host is refused — including dressed-up forms (userinfo before `@`, `Host`-header override of an absolute target, subdomain, appended suffix). | `sandbox-adversarial.test.ts` Group 1 ("a different host dressed up … is always 403"). |
| G3 | **HTTP and CONNECT enforce identically.** Case, IPv6 brackets, and trailing dots are normalized the same way on both paths (the asymmetry fix). | Group 1 (CONNECT case-variant; IPv6 denied not mis-parsed) + Group 3 unit pins. |
| G4 | **A secret never enters the sandbox.** The tool names a secret; the value is injected at egress only and appears in no stdout/stderr/env/`/workspace`. | Group 2 ("brokered secret never enters any sandbox-visible surface") + existing inmemory test. |
| G5 | **The marker never reaches upstream; the secret never returns to the client.** `x-iris-secret` is stripped before forwarding; the response carries no secret. | Group 2 (marker stripped / brokered upstream-only / not in body). |
| G6 | **No brokering over a CONNECT tunnel.** A TLS tunnel is end-to-end; the proxy gates the host but injects no credential, and the audit record carries none. | Group 2 ("CONNECT tunnel carries NO secret"). |
| G7 | **Unknown secrets fail loud, before egress.** An unknown/empty/wrong-case secret name → `403`, zero egress, upstream untouched. Prototype-pollution names (`__proto__`, `constructor`, …) are refused (the broker uses `hasOwnProperty`). | Group 2 (unknown/empty/wrong-case; prototype-pollution). |

Host canonicalization (`normalizeHost`) folds only **DNS-equivalent** forms —
lowercase, `[::1]`↔`::1`, single trailing dot — so it can never broaden an entry
to admit a genuinely different host. Group 3 pins this exactly.

## Findings

**F1 — HTTP/CONNECT normalization asymmetry (fixed).** The proxy's HTTP path
resolved the host via `URL.hostname` (IDNA-folded, lowercased), but the CONNECT
path used a raw `authority.split(":")` with no normalization — which also mangled
a bracketed IPv6 authority (`[::1]:443` → host `"["`). And `networkAllows` did a
raw, case-sensitive `Array.includes`, so a mis-cased allowlist *entry*
(`ALLOWED.COM`) silently never matched. **This was fail-closed** (the worst case
was a false *denial*, never an unintended *allow*), so it was a robustness/footgun
defect, not an exploitable bypass. **Fix:** a single `normalizeHost` applied at
the allowlist boundary (both the host and every entry) plus a URL-based CONNECT
authority parse, so all three enforcement paths (HTTP, CONNECT, in-memory) agree.
Pinned by `sandbox-adversarial.test.ts` Groups 1 and 3.

**F2 — secret-name whitespace is HTTP-normalized (benign).** A `x-iris-secret`
value with leading/trailing spaces (`" API_KEY "`) is delivered as `"API_KEY"`
because HTTP transport strips optional whitespace (OWS, RFC 7230). This resolves
to the *same* secret the caller was already entitled to name — it is not a leak
and not a bypass (you can only name secrets the broker holds). Documented here so
the exact-match expectation is not mistaken for a vulnerability. Secret names are
otherwise exact-match and **case-sensitive** (broker store keys).

## Honest boundaries (what this does NOT claim)

- **Brokering is plaintext-HTTP only.** A CONNECT/HTTPS tunnel is end-to-end TLS;
  the proxy enforces the host allowlist but cannot inject a credential without
  terminating TLS (MITM). Brokering-over-TLS is **deferred, not faked** — the
  CONNECT handler gates the host but injects no credential.
- **Docker-level enforcement is cooperative by default.** `--network=bridge` +
  `HTTP(S)_PROXY` routes well-behaved clients through the proxy; *hard*
  enforcement (the proxy as the sole egress) is a deployment concern — run the
  container on an internal network so the proxy is the only route out. The secure
  floor (no-proxy `{allow}` refused; `deny-all` = no network at all) does not
  depend on cooperation.
- **IDNA/punycode equivalence for allowlist *entries* is out of scope.** Entries
  are expected to be pre-normalized ASCII. Request-side IDNA folding via
  `URL.hostname` is a one-way hardening that maps confusables to punycode, which
  will *not* match an ASCII entry (→ denied) — so it stays fail-closed.
- **The secret in `egress[]` is host-side audit, not a leak.** It lives outside
  the sandbox; the sandbox surfaces never carry it, and the proxy never logs it
  separately.

## Residuals

- A deployed, adversarial load test of the docker backend behind a hard
  network boundary (not the cooperative default) — needs real infra.
- Brokering-over-TLS, if ever required, needs an explicit TLS-termination design
  (and a re-review) — today it is correctly refused, not faked.
