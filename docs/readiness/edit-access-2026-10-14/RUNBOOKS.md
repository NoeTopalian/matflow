# Runbooks (14 Oct 2026) — owner login-address correction; production verification after an approved deployment

No address, credential or ticket appears in this file. Addresses are supplied by the people involved at the point of use.

## A. Correcting a club owner's sign-in address (the Total BJJ case)

**Evidence state (read-only production query, 14 Oct 10:58 UK):** the intended address is held by exactly ONE record in the club — a **cancelled, imported MEMBER record** — and by nothing in any other club. The owner login currently uses the club-domain address. This is the single-member-holder shape the **deployed** hub workflow (`9272a21`) resolves; PR #29 is needed only for staff or multi-holder conflicts.

**Who:** Noe, as a named operator (MFA, allow-listed), outside any support session. Never ad hoc SQL; never delete/recreate; never reset credentials.

1. Hub → the club → **Owner's sign-in email (back office)** card → *Check* with the intended address. Expect: "a member record holds it" (one holder, kind **Member record (gym customer)**). If it reports a staff account or several holders, stop — that shape needs PR #29.
2. *Change this member's contact address* → enter the **replacement contact address for the cancelled member record** (Noe decides; the member is cancelled and imported, so TeamUp refresh matching for that record is affected — accepted) → authenticator code → confirm. The audit row carries keyed digests only.
3. *Change the owner's sign-in email* → the intended address → authenticator code → confirm. Effects, by design: the owner's existing sessions end (`sessionVersion` +1); reset codes and sign-in links for the old and new address are retired; the new address is marked unverified → **password sign-in keeps working**; password reset / emailed links are refused until verified; TOTP is untouched.
4. **Verification:** Sean signs in at the club login (club code `totalbjj`) with the new address, his own password and his own authenticator. Noe confirms with him by voice/message. Recovery path if his password is unknown: operator-set temporary password through Settings → Staff (forces change; expires 72 h) — Noe's call, not part of this runbook.
5. Only after step 4 is confirmed: consider deleting the `pre-hub-release` Neon branch (its recovery purpose is then resolved); rotate `CRON_SECRET` as a separate, coordinated step with a cron-run verification.

## B. Production verification after an approved deployment of PR #31/#33

Deployment authority (merge) and customer-account authority are separate; nothing below touches a customer club.

1. **Serving source:** confirm the deployment's commit SHA in Vercel matches the approved merge; confirm no migration ran (the diff has none).
2. **Operator access:** sign in to the hub with MFA; confirm your operator id is in `OPERATOR_ALLOWED_IDS` (a de-listed operator is refused); confirm the legacy `matflow_admin` cookie path is refused (production env).
3. **View session (demo club only):** start View on the demo club → banner reads "read-only" and names the club → any write (e.g. save branding) is refused → End session.
4. **Edit session (an expressly authorised synthetic club only — create one for this purpose; never a customer):** start Edit → banner reads "EDIT session — <club>" → create a class → edit a member's phone → save branding → attempt a refused operation (e.g. member status) → 403 → End session → sign in as that club's owner → Activity shows the rows with "by MatFlow support" and the session start/end labels; the operator Activity shows the `support.edit.refused` row for the attempt.
5. **Observation window:** watch application errors and the operator Activity for unexpected denials for the agreed window; if a critical check fails, stop support/customer mutations and redeploy `9272a21` (no schema change ⇒ direct rollback is safe).
6. Record outcomes against the release packet; tear down the synthetic club.
