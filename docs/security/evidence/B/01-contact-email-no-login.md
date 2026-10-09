# B-01 — "Contact-email route refuses no-login records" (reconciliation)

Lane B, 9 Oct 2026. Candidate `2a6487e` (branch `security/assurance-2026-10`). TEST branch only, synthetic data.

## What each term means in this schema and code (resolved from source)

| Term in reports | Field state (schema `Member`) | Where decided | Can the hub contact route correct it? |
|---|---|---|---|
| **No-login record** | `Member.email` ends `@no-login.matflow.local` (`lib/synthesise-kid-email.ts` `isSynthesisedEmail`, domain match, case-insensitive). Written for children (`synthesiseKidEmail`), adults with no address at TeamUp, a second adult sharing an address, and guardian drafts from an emergency contact. | `managedAddress()` in the contact route; `canSignIn:false` in `lib/login-email.ts` holders | **No — refused 409 `managed`** (by design: giving a placeholder a real address makes a contact-only row reachable by address) |
| **No password** | `Member.passwordHash IS NULL`. NOT "cannot sign in": invite/activation, magic link and reset reach a passwordless member through a real address. | `findLoginHolders` `hasPassword`; check route `access` (`password` / `activation_pending` / `none`) | **Yes** — passwordless is not a refusal reason; `sessionVersion` is bumped only when a password exists |
| **Managed record** | Either of the two system-owned address shapes: synthesised no-login, or the erasure sentinel. Nothing else. | `managedAddress = isSynthesisedEmail ∨ /^deleted-.*@deleted\.invalid$/i`, checked at preflight AND on the re-read inside the transaction | No (409), and either shape is refused as a target (400) |
| **Erased record** | `email = deleted-<memberId>@deleted.invalid`, `status = cancelled` (DSAR erase route `app/api/admin/dsar/erase/route.ts:302`) | same | No (409) — a live address would undo an Article 17 erasure |
| **Authentication-capable record** | A User row (always), or a Member whose address is real (not managed). Capability *now* = password, or a live reset/login/first_time_signup token for that address in that club (check route `access`). | `lib/login-email.ts` `canSignIn` (conservative: real address ⇒ reachable); check route `access` | Yes, if real; the route retires that club's sign-in tokens for the old and new address in the same transaction |
| `unverifiedEmail` | Contact only (shared payer address); **not** a login, not claimed, not a holder | `findLoginHolders` reads `email` only | Not involved — never blocks the owner's address |
| `externalRef` | Import identity `teamup:<email>|<name>` | never written by the route | Unchanged byte-for-byte |
| `status` / `accountType` | Standing / age band. **Neither is consulted** by the managed-record guard | — | `cancelled` does not block |

## What a real TeamUp import writes (lib/importers/teamup.ts + commit route columnsFor)

Adult with a real address and only historical memberships → `email` = the address (lower-cased), `passwordHash` NULL,
`status` `cancelled` (or `inactive` for a completed prepaid course), `paymentStatus` `cancelled`, `cancelledAt` from the
export, `billedBy` `teamup`, `importJobId` set, `externalRef` `teamup:<email>|<name>`, `accountType` `adult`. That is
the ONLY importer shape that holds a real login address; every other shape (child, no-email adult, second adult on a
shared address, guardian draft) is written on a synthesised address with the real one, if any, in `unverifiedEmail`.

## Reproduction (real import + real hub routes, both DB roles)

`tests/integration/sec-b-sean-imported-cancelled-db.test.ts` — the club is imported through the real commit route
from a synthetic TeamUp file (founder cancelled; a second adult and a child on the same address), then:

1. field states asserted exactly as above (founder real address, NULL password, cancelled, externalRef, billedBy, importJobId; second adult synthesised + `unverifiedEmail`; child synthesised + suggested unconfirmed link);
2. check → exactly one holder, the cancelled founder (`access: none`, `canSignIn: false`), not `many`;
3. guard kept: child (no-login), shared-address adult (no-login) and an erased-shaped record → 409 `managed`, rows byte-identical; a placeholder target → 400;
4. **the cancelled, imported, passwordless founder IS corrected** → 200; only `email` changes (externalRef, status, paymentStatus, cancelledAt, billedBy, importJobId, passwordHash, sessionVersion identical; child link and second adult identical);
5. re-check free → hub owner login change → 200; the sign-in lookup auth.ts performs (`findUnique` on `(tenantId, email)` in User and Member under `withTenantContext`) resolves the address to the owner and to no member; the founder is reachable on the new address;
6. a later import of a changed file creates no second founder and leaves the owner row byte-identical; no member holds the address.

| Run | Runner | Exit | Result |
|---|---|---|---|
| owner role (`neondb_owner`) | `bash <scratchpad>/att/run-engine.sh tests/integration/sec-b-sean-imported-cancelled-db.test.ts` | 0 | 6/6 |
| restricted (`matflow_app`, `RLS_ENFORCED=1`) | `bash <scratchpad>/q78/run-restricted.sh tests/integration/sec-b-sean-imported-cancelled-db.test.ts` | 0 | 6/6 |
| mutant A — guard broadened to refuse passwordless or cancelled records (scratch edit, reverted) | owner runner | 1 | 4 failed (3,4,5,6) — the test detects an over-broad guard that would block Sean |
| mutant B — managed-record guard removed at preflight and in the transaction (scratch edit, reverted) | owner runner | 1 | 1 failed (3) — the test detects a removed guard |

Route file restored after each mutant (`git diff --quiet` on the route: clean). First run's teardown failed on
`Member_kids_must_have_parent` (children must be deleted first); fixed in the test, and the abandoned synthetic club was
removed with `SEC_B_SWEEP=1 … tests/integration/sec-b-fixture-sweep-db.test.ts` (prefix `secb-` only, count-checked, exit 0).

## Disposition

**NOT A DEFECT (the reported refusal is narrower than the wording suggested) — PASS at I level, both roles.** The
route refuses only system-managed addresses; "no password", "cancelled" and "imported" are not refusal reasons, and the
intended record can be corrected through the hub with the guard intact. No code change. The only importer state that
would make Sean's own record un-correctable is a managed address, and in that state the record does not hold the
owner's address at all (the address is in `unverifiedEmail`, which never blocks the owner's change) — so no missing
workflow exists for this scenario. Residual: the production record's actual field state was not inspected (production
read-only inspection is the lead's job); the runbook step "check → member record to the `+member` address → re-check →
owner login change" is the supported workflow this test exercises.
