# B-04 — AH-C2 version-at-check semantics (SEC-028)

Lane B, 9 Oct 2026, candidate `2a6487e`. TEST branch, synthetic data, both DB roles.
Test: `tests/integration/sec-b-version-at-check-db.test.ts` — owner runner exit 0 (4/4), restricted runner exit 0 (4/4).
Logs: `<scratchpad>/security/B/logs/version-owner.log`, `version-restricted.log`.

## What binds what (measured)

| Route | Version the operator SAW | Version bound into the grant | Change between "saw" and "code" | Change after "code" |
|---|---|---|---|---|
| Hub member contact email | YES — the check returns an opaque keyed version; the body carries it; compared at preflight and again inside the transaction | state at issue | **409 stale, nothing written, grant unspent**; re-check → the same grant then succeeds (cell 1) | 409 stale, nothing written (cell 2) |
| Operator owner login email | NO page-load version | state at issue (owner id, sessionVersion, address, provisional mark) | **not detected** — the change applies over an address the operator never saw (cell 4, characterisation) | 409 `stale`, nothing written (cell 3) |
| Other step-up routes (password reset, 2FA reset, profile, transfer, suspend, soft-delete, member 2FA reset) | NO | state at issue | not detected (by construction — no page version exists; not separately run by lane B) | 409 stale via `consumeStepUpGrant` (code read; DB-tested by the admin-hub `operator-step-up-db` suite, not re-run by lane B) |

## Classification

**AH-C2: APPLICABLE, OPEN — Low.** The security-relevant decision on the conflict path — *who holds the address* — is
check-time bound (member route). On the other routes the operator re-confirms with a fresh code immediately before the
grant is issued, every later change is refused, and each action is a reset or replacement to a value the operator
chose; the gap is that a change made by the subject between page load and code entry is overwritten rather than shown
(e.g. cell 4: an address the owner set themselves seconds earlier is replaced, and the owner is signed out). It needs an
operator with step-up acting at that moment; it is not attacker-reachable on its own. Not a release blocker in lane B's
assessment; the lead decides.

**Proposed fix (not applied — touches a unit test outside lane B's prefix and the operator UI):** the address check and
the owner card return `owner.version = stepUpVersionDigestIn(tx, "owner.login_email", target)`; the owner route accepts
an optional `version` and answers 409 `stale` before the spend when it differs (preflight) and again inside the
transaction; the UI sends the version it rendered. `tests/unit/operator-hub-conflict-routes.test.ts` pins the check's
`owner` object with `toEqual`, so that file must be updated with the change. Cell 4 then flips to 409 by design.

SEC-028 overall: APPLICABLE — PASS at I for the member route and for post-confirmation changes on every route tested;
AH-C2 residual OPEN (Low) for pre-confirmation changes on the owner route.
